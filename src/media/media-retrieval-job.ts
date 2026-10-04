/**
 * A controlled, resumable media retrieval batch. Source-agnostic: the
 * per-item work is done by an injected retriever (Instagram today).
 *
 * Each run makes sure every main-archive item of the owner has a retrieval
 * request, then works through due requests one at a time: highest priority
 * first, newest item first within a priority. It stops early only on a rate
 * limit; any other failure is recorded on that item and the batch moves on.
 * All state lives in the requests, so running again simply continues.
 *
 * Only the main archive (Saved + Messages) is retrieved. Liked-only items get
 * no new requests, and requests they already have are left exactly as they
 * are: never selected, never modified, and not counted in the summary.
 */
import type { ArchiveItemId, IsoDateTime, UserId } from "../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import {
  newRetrievalRequest,
  RETRIEVAL_PRIORITY,
  type MediaRetrievalRequest,
  type RetrievalStatus,
} from "../domain/media-retrieval.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";

/** Does the actual retrieval for one item and returns its updated request. */
export interface MediaRetrievalJobItemRetriever {
  retrieve(itemId: ArchiveItemId): Promise<{ request: MediaRetrievalRequest; mediaType?: string }>;
}

export type MediaRetrievalJobOptions = {
  repository: ArchiveRepository;
  retriever: MediaRetrievalJobItemRetriever;
  /** Pause between items, to be gentle with the source. */
  delayMs?: number;
  now?: () => IsoDateTime;
  sleep?: (ms: number) => Promise<void>;
};

export type JobItemOutcome = "stored" | "unavailable" | "failed" | "rate_limited" | "error";

export type JobItemResult = {
  itemId: ArchiveItemId;
  outcome: JobItemOutcome;
  mediaType?: string;
  detail?: string;
};

export type MediaRetrievalJobSummary = {
  /** Requests created this run for items that had none. */
  enqueued: number;
  attempted: number;
  stored: number;
  unavailable: number;
  /** Temporary failures, scheduled for a retry. */
  failed: number;
  /** Unexpected errors; the item stays as it was and is retried next run. */
  errors: number;
  /** Items whose media was already stored (never fetched again). */
  alreadyStored: number;
  rateLimited: boolean;
  /** Due items left for a later run because of the limit or a rate limit. */
  remainingDue: number;
  statusBefore: Record<RetrievalStatus, number>;
  statusAfter: Record<RetrievalStatus, number>;
  durationMs: number;
  items: JobItemResult[];
};

export class MediaRetrievalJob {
  private readonly options: Required<MediaRetrievalJobOptions>;

  constructor(options: MediaRetrievalJobOptions) {
    this.options = {
      delayMs: 0,
      now: () => new Date().toISOString(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
  }

  async run(params: { ownerId: UserId; limit: number; maxPriority?: number }): Promise<MediaRetrievalJobSummary> {
    const { repository, delayMs, now, sleep } = this.options;
    const started = Date.now();
    const scope = { ownerId: params.ownerId, sources: MAIN_ARCHIVE_SOURCES };
    const enqueued = await this.enqueueMissing(params.ownerId);
    const statusBefore = await repository.countMediaRetrievalsByStatus(scope);

    const due = await repository.listDueMediaRetrievals(now(), params.limit, {
      ...scope,
      order: "newest",
      ...(params.maxPriority !== undefined && { maxPriority: params.maxPriority }),
    });

    const items: JobItemResult[] = [];
    let rateLimited = false;
    for (const [index, request] of due.entries()) {
      if (index > 0 && delayMs > 0) await sleep(delayMs);
      const result = await this.attempt(request.archiveItemId);
      items.push(result);
      if (result.outcome === "rate_limited") {
        rateLimited = true;
        break;
      }
    }

    const count = (outcome: JobItemOutcome) => items.filter((i) => i.outcome === outcome).length;
    const statusAfter = await repository.countMediaRetrievalsByStatus(scope);
    const remainingDue = (await repository.listDueMediaRetrievals(now(), Number.MAX_SAFE_INTEGER, {
      ...scope,
      ...(params.maxPriority !== undefined && { maxPriority: params.maxPriority }),
    })).length;
    return {
      enqueued,
      attempted: items.length,
      stored: count("stored"),
      unavailable: count("unavailable"),
      failed: count("failed"),
      errors: count("error"),
      alreadyStored: statusBefore.stored,
      rateLimited,
      remainingDue,
      statusBefore,
      statusAfter,
      durationMs: Date.now() - started,
      items,
    };
  }

  private async attempt(itemId: ArchiveItemId): Promise<JobItemResult> {
    let request: MediaRetrievalRequest;
    let mediaType: string | undefined;
    try {
      ({ request, mediaType } = await this.options.retriever.retrieve(itemId));
    } catch (error) {
      return { itemId, outcome: "error", detail: error instanceof Error ? error.message : String(error) };
    }
    const base = { itemId, ...(mediaType && { mediaType }) };
    if (request.lastFailure?.code === "rate_limited" && request.status === "failed") {
      return { ...base, outcome: "rate_limited", detail: request.lastFailure.message };
    }
    if (request.status === "stored") return { ...base, outcome: "stored" };
    if (request.status === "unavailable") return { ...base, outcome: "unavailable", detail: request.lastFailure?.message ?? "" };
    if (request.status === "failed") return { ...base, outcome: "failed", detail: request.lastFailure?.message ?? "" };
    return { ...base, outcome: "error", detail: `Request still ${request.status} after retrieval` };
  }

  /** One request per main-archive item, created in a single transaction. */
  private async enqueueMissing(ownerId: UserId): Promise<number> {
    const { repository, now } = this.options;
    const createdAt = now();
    return repository.withTransaction(async (repo) => {
      let created = 0;
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const page = await repo.listArchiveItems(ownerId, { limit: pageSize, offset, sources: MAIN_ARCHIVE_SOURCES });
        for (const item of page) {
          // Every item is "normal" until owner-exchange detection exists.
          if (await repo.enqueueMediaRetrieval(newRetrievalRequest(item.id, RETRIEVAL_PRIORITY.normal, createdAt))) created++;
        }
        if (page.length < pageSize) return created;
      }
    });
  }
}
