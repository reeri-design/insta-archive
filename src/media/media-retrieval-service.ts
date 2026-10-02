import type {
  ArchiveItemAggregate,
  ArchiveItemId,
  IsoDateTime,
  MediaAsset,
  MediaAssetId,
  MediaRetrieval,
  OriginalMetadata,
  UserId,
} from "../domain/archive-item.ts";
import {
  contentAssetId,
  defaultRetryPolicy,
  derivedFrameAssetId,
  newRetrievalRequest,
  recordRetrievalFailure,
  recordRetrievalSuccess,
  requestManualRetry,
  RETRIEVAL_PRIORITY,
  type MediaRetrievalRequest,
  type RetrievalFailure,
  type RetrievalPriority,
  type RetryPolicy,
} from "../domain/media-retrieval.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import type {
  DerivedFrame,
  MediaSourceAdapter,
  RetrievedMetadata,
} from "./media-source-adapter.ts";
import { storageKeyFor, type MediaStorage } from "./media-storage.ts";

/** Decides an item's queue priority. Injected so the rule can evolve. */
export type PriorityPolicy = (aggregate: ArchiveItemAggregate) => RetrievalPriority;

export const normalPriority: PriorityPolicy = () => RETRIEVAL_PRIORITY.normal;

/**
 * Owner-exchange items first, everything else normal. How an exchange between
 * the owner's own accounts is recognised is left to the caller for now.
 */
export function ownerExchangePriority(
  isOwnerExchange: (aggregate: ArchiveItemAggregate) => boolean,
): PriorityPolicy {
  return (aggregate) =>
    isOwnerExchange(aggregate) ? RETRIEVAL_PRIORITY.ownerExchange : RETRIEVAL_PRIORITY.normal;
}

export type RetrievalRun = {
  request: MediaRetrievalRequest;
  /** Content assets newly stored in this run. */
  storedAssets: number;
  /** True when nothing ran because all media was already stored. */
  alreadyStored: boolean;
};

export type MediaRetrievalServiceOptions = {
  repository: ArchiveRepository;
  storage: MediaStorage;
  adapters: MediaSourceAdapter[];
  retryPolicy?: RetryPolicy;
  now?: () => IsoDateTime;
};

/**
 * Runs media retrieval for ArchiveItems: picks the adapter, stores original
 * bytes in MediaStorage, records MediaAssets and the request's new state.
 *
 * Network and file I/O happen outside any database transaction; the
 * resulting state is then written in one transaction. A failed retrieval
 * never touches the ArchiveItem itself.
 */
export class MediaRetrievalService {
  private readonly repository: ArchiveRepository;
  private readonly storage: MediaStorage;
  private readonly adapters: MediaSourceAdapter[];
  private readonly retryPolicy: RetryPolicy;
  private readonly now: () => IsoDateTime;

  constructor(options: MediaRetrievalServiceOptions) {
    this.repository = options.repository;
    this.storage = options.storage;
    this.adapters = options.adapters;
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Queue an item; a no-op if it already has a request. */
  async enqueue(itemId: ArchiveItemId, priority: PriorityPolicy = normalPriority): Promise<boolean> {
    const aggregate = await this.repository.getArchiveItemAggregate(itemId);
    if (!aggregate) throw new Error(`Unknown archive item ${itemId}`);
    return this.repository.enqueueMediaRetrieval(
      newRetrievalRequest(itemId, priority(aggregate), this.now()),
    );
  }

  /** Queue every item of an owner that has no request yet. */
  async enqueueAll(
    ownerId: UserId,
    priority: PriorityPolicy = normalPriority,
  ): Promise<{ created: number; existing: number }> {
    const counts = { created: 0, existing: 0 };
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const items = await this.repository.listArchiveItems(ownerId, { limit: pageSize, offset });
      for (const item of items) {
        if (await this.enqueue(item.id, priority)) counts.created++;
        else counts.existing++;
      }
      if (items.length < pageSize) return counts;
    }
  }

  /** User-initiated retry, regardless of status or backoff. */
  async retryManually(itemId: ArchiveItemId): Promise<MediaRetrievalRequest> {
    const request = await this.repository.getMediaRetrievalRequest(itemId);
    if (!request) throw new Error(`No retrieval request for ${itemId}`);
    const retried = requestManualRetry(request, this.now());
    await this.repository.saveMediaRetrievalRequest(retried);
    return retried;
  }

  /** Run the highest-priority due request, if any. */
  async processNext(): Promise<RetrievalRun | undefined> {
    const [next] = await this.repository.listDueMediaRetrievals(this.now(), 1);
    return next && this.process(next.archiveItemId);
  }

  /** Run the item's request now. Already-stored requests are left as they are. */
  async process(itemId: ArchiveItemId): Promise<RetrievalRun> {
    const request = await this.repository.getMediaRetrievalRequest(itemId);
    if (!request) throw new Error(`No retrieval request for ${itemId}`);
    if (request.status === "stored") return { request, storedAssets: 0, alreadyStored: true };

    const aggregate = await this.repository.getArchiveItemAggregate(itemId);
    if (!aggregate) throw new Error(`Unknown archive item ${itemId}`);
    const { item } = aggregate;
    const adapter = this.adapters.find((a) => a.canRetrieve(item));
    if (!adapter) throw new Error(`No media source adapter can retrieve ${itemId}`);

    const existing = new Map(
      aggregate.media
        .filter((m): m is Extract<MediaAsset, { role: "content" }> => m.role === "content")
        .map((m) => [m.position, m]),
    );
    const storedPositions = new Set<number>();
    for (const [position, asset] of existing) {
      if (asset.retrieval.status === "stored" && (await this.storage.has(asset.retrieval.storageKey))) {
        storedPositions.add(position);
      }
    }

    const now = this.now();
    let outcome;
    try {
      outcome = await adapter.retrieve(item, { storedPositions });
    } catch (error) {
      outcome = { ok: false as const, failure: unexpected(error) };
    }

    if (!outcome.ok) {
      const failed = recordRetrievalFailure(request, outcome.failure, now, this.retryPolicy);
      await this.repository.saveMediaRetrievalRequest(failed);
      return { request: failed, storedAssets: 0, alreadyStored: false };
    }

    // Store bytes first (outside the transaction); keys are deterministic, so
    // a crash before the state is saved is repaired by the next attempt.
    const assets: MediaAsset[] = [];
    const failures: RetrievalFailure[] = [];
    let storedAssets = 0;
    for (const retrieved of outcome.assets) {
      const previous = existing.get(retrieved.position);
      if (storedPositions.has(retrieved.position) || retrieved.result.ok === "already_stored") {
        continue;
      }
      const id = contentAssetId(item.id, retrieved.position);
      const base = { id, archiveItemId: item.id, mediaType: retrieved.mediaType, role: "content" as const, position: retrieved.position };
      const result = retrieved.result;

      let retrieval: MediaRetrieval;
      if (result.ok) {
        try {
          const stored = await this.storage.put(storageKeyFor(item.id, id, result.mimeType), result.bytes);
          retrieval = {
            status: "stored",
            storageKey: stored.storageKey,
            mimeType: result.mimeType,
            retrievedAt: now,
            ...(result.width !== undefined && { width: result.width }),
            ...(result.height !== undefined && { height: result.height }),
            ...(result.durationMs !== undefined && { durationMs: result.durationMs }),
          };
          storedAssets++;
        } catch (error) {
          const failure: RetrievalFailure = { kind: "temporary", code: "storage_error", message: messageOf(error) };
          failures.push(failure);
          retrieval = assetFailure(failure, previous, now);
        }
      } else {
        failures.push(result.failure);
        retrieval = assetFailure(result.failure, previous, now);
      }
      assets.push({ ...base, retrieval });
    }

    const anyStored = storedPositions.size > 0 || storedAssets > 0;
    const temporary = failures.find((f) => f.kind === "temporary");
    const next = temporary
      ? recordRetrievalFailure(request, temporary, now, this.retryPolicy)
      : anyStored
        ? recordRetrievalSuccess(request, now)
        : recordRetrievalFailure(
            request,
            failures[0] ?? { kind: "unavailable", code: "not_found", message: "The source returned no media" },
            now,
            this.retryPolicy,
          );

    const original = fillMissingOriginalMetadata(item.original, outcome.metadata, now);
    const learnedKind = item.kind === "unknown" ? outcome.kind : undefined;

    await this.repository.withTransaction(async (repo) => {
      if (assets.length > 0) await repo.saveMediaAssets(assets);
      if (original !== item.original) await repo.saveOriginalMetadata(item.id, original);
      if (learnedKind) await repo.saveArchiveItem({ ...item, kind: learnedKind, updatedAt: now });
      await repo.saveMediaRetrievalRequest(next);
    });
    return { request: next, storedAssets, alreadyStored: false };
  }

  /**
   * Store frames derived from a stored video as `derived_frame` assets. The
   * video itself is never changed or replaced.
   */
  async storeDerivedFrames(
    itemId: ArchiveItemId,
    videoAssetId: MediaAssetId,
    frames: DerivedFrame[],
  ): Promise<MediaAsset[]> {
    const aggregate = await this.repository.getArchiveItemAggregate(itemId);
    const video = aggregate?.media.find((m) => m.id === videoAssetId);
    if (!video || video.role !== "content" || video.mediaType !== "video" || video.retrieval.status !== "stored") {
      throw new Error(`${videoAssetId} is not a stored video of ${itemId}`);
    }

    const now = this.now();
    const assets: MediaAsset[] = [];
    for (const frame of frames) {
      const id = derivedFrameAssetId(videoAssetId, frame.frameTimeMs);
      const stored = await this.storage.put(storageKeyFor(itemId, id, frame.mimeType), frame.bytes);
      assets.push({
        id,
        archiveItemId: itemId,
        mediaType: "image",
        role: "derived_frame",
        derivedFromAssetId: videoAssetId,
        frameTimeMs: frame.frameTimeMs,
        retrieval: {
          status: "stored",
          storageKey: stored.storageKey,
          mimeType: frame.mimeType,
          retrievedAt: now,
          ...(frame.width !== undefined && { width: frame.width }),
          ...(frame.height !== undefined && { height: frame.height }),
        },
      });
    }
    await this.repository.saveMediaAssets(assets);
    return assets;
  }
}

/**
 * Adds retrieved values only for fields the item does not have yet, tagged
 * with retrieval provenance. Existing (export) values are never replaced.
 * Returns the same object when nothing was added.
 */
export function fillMissingOriginalMetadata(
  original: OriginalMetadata,
  retrieved: RetrievedMetadata | undefined,
  retrievedAt: IsoDateTime,
): OriginalMetadata {
  if (!retrieved) return original;
  const provenance = { from: "retrieval" as const, retrievedAt };
  const filled: OriginalMetadata = { ...original };
  let changed = false;
  if (!original.creator && retrieved.creator && (retrieved.creator.username || retrieved.creator.displayName)) {
    filled.creator = { value: retrieved.creator, provenance };
    changed = true;
  }
  if (!original.caption && retrieved.caption?.trim()) {
    filled.caption = { value: retrieved.caption, provenance };
    changed = true;
  }
  if (!original.postedAt && retrieved.postedAt) {
    filled.postedAt = { value: retrieved.postedAt, provenance };
    changed = true;
  }
  return changed ? filled : original;
}

/** Per-asset state for a failed asset, building on the asset's previous state. */
function assetFailure(
  failure: RetrievalFailure,
  previous: MediaAsset | undefined,
  now: IsoDateTime,
): MediaRetrieval {
  if (failure.kind === "unavailable") {
    return { status: "unavailable", checkedAt: now, reason: failure.code, detail: failure.message };
  }
  const attempts = previous?.retrieval.status === "failed" ? previous.retrieval.attempts + 1 : 1;
  return { status: "failed", lastAttemptAt: now, attempts, error: `${failure.code}: ${failure.message}` };
}

function unexpected(error: unknown): RetrievalFailure {
  return { kind: "temporary", code: "unknown", message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
