/**
 * Reel media strategy (Step 08B.5; builds on spikes 08B.3–08B.4).
 *
 * A Reel's video is its canonical media. After downloading it:
 *  - byteLength <= maxRetainedVideoBytes → store the video unchanged as the
 *    Reel's `content` video asset;
 *  - otherwise → write it to a temporary file, extract frames at an interval
 *    chosen by the video's size (see FRAME_INTERVAL_BUCKETS; first and final
 *    frame included), store the frames as
 *    `derived_frame` assets without `derivedFromAssetId`, and delete the
 *    video. No video asset is kept.
 * The threshold is configurable and experimental (REEL_MAX_RETAINED_VIDEO_BYTES).
 *
 * When the source withholds the video (no video URL) but publishes the
 * Reel's cover image, the cover is stored with the `cover` role and the
 * video's `content` asset is recorded as unavailable. The cover is never
 * treated as the video or as a frame of it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArchiveItemAggregate,
  ArchiveItemId,
  IsoDateTime,
  MediaAsset,
  MediaAssetId,
} from "../../domain/archive-item.ts";
import {
  contentAssetId,
  coverAssetId,
  newRetrievalRequest,
  recordRetrievalFailure,
  recordRetrievalSuccess,
  RETRIEVAL_PRIORITY,
  type MediaRetrievalRequest,
  type RetrievalFailure,
} from "../../domain/media-retrieval.ts";
import type { ArchiveRepository } from "../../persistence/archive-repository.ts";
import type { MediaSourceAdapter, RetrievedAsset } from "../media-source-adapter.ts";
import { storageKeyFor, type MediaStorage } from "../media-storage.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * EXPERIMENTAL default: 20 MB. The test Reel (08B.3) was 2.17 MB for 12.4 s
 * (~1.4 Mbit/s), so this keeps the video for Reels up to roughly 2 minutes at
 * that bitrate. Override with REEL_MAX_RETAINED_VIDEO_BYTES.
 */
export const DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES = 20_000_000;

export function reelMaxRetainedVideoBytesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.REEL_MAX_RETAINED_VIDEO_BYTES?.trim();
  if (!raw) return DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`REEL_MAX_RETAINED_VIDEO_BYTES must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Frame sampling
// ---------------------------------------------------------------------------

/**
 * EXPERIMENTAL: sampling interval on the frames-only path, by downloaded video
 * size. Frames are a visual summary, so bigger videos are sampled more
 * sparsely. Checked top to bottom; the last bucket covers every video that
 * reaches the frames path (by default, larger than 20 MB).
 */
export const FRAME_INTERVAL_BUCKETS: readonly { overBytes: number; intervalMs: number }[] = [
  { overBytes: 100_000_000, intervalMs: 12_000 },
  { overBytes: 50_000_000, intervalMs: 8_000 },
  { overBytes: 0, intervalMs: 4_000 },
];

/** Interval between sampled frames for a video of this many bytes. */
export function frameIntervalForVideoBytes(byteLength: number): number {
  const bucket = FRAME_INTERVAL_BUCKETS.find((b) => byteLength > b.overBytes) ?? FRAME_INTERVAL_BUCKETS.at(-1);
  if (!bucket) throw new Error("FRAME_INTERVAL_BUCKETS is empty");
  return bucket.intervalMs;
}

/**
 * Which decoded frames to keep, given every frame's timestamp (ms, in
 * presentation order): the first frame, then the first frame at or after
 * each `intervalMs` mark, then the final frame if it was not already picked.
 */
export function selectFrameIndices(frameTimesMs: readonly number[], intervalMs: number): number[] {
  if (!(intervalMs > 0)) throw new Error(`intervalMs must be positive, got ${intervalMs}`);
  const last = frameTimesMs.length - 1;
  const start = frameTimesMs[0];
  if (start === undefined) return [];
  const picked: number[] = [];
  let i = 0;
  for (let target = start; i <= last; target += intervalMs) {
    // Half a millisecond of slack absorbs float noise in decoder timestamps.
    while (i <= last && (frameTimesMs[i] ?? Infinity) < target - 0.5) i++;
    if (i <= last && picked.at(-1) !== i) picked.push(i);
  }
  if (picked.at(-1) !== last) picked.push(last);
  return picked;
}

/** Turns a video file into frame images. */
export interface FrameExtractor {
  /**
   * Writes frames sampled every `intervalMs` (see selectFrameIndices) into
   * `outDir`, chronologically, and describes them.
   */
  extract(videoPath: string, outDir: string, intervalMs: number): Promise<ExtractedFrame[]>;
}

export type ExtractedFrame = {
  /** Actual timestamp of the frame, from the start of the video. */
  frameTimeMs: number;
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
};

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type ReelRepresentation = "video" | "frames" | "cover";

export type ReelMediaRun = {
  request: MediaRetrievalRequest;
  /** How the Reel is (now) represented; undefined if retrieval failed. */
  representation?: ReelRepresentation;
  assets: MediaAsset[];
  /** Size of the downloaded video, when one was downloaded in this run. */
  videoByteLength?: number;
  /** True when the Reel was already stored and nothing was fetched. */
  alreadyComplete: boolean;
};

export type ReelMediaRetrievalOptions = {
  repository: ArchiveRepository;
  storage: MediaStorage;
  /** The 08B.3 Reel adapter (or a stand-in in tests). */
  adapter: MediaSourceAdapter;
  extractor: FrameExtractor;
  maxRetainedVideoBytes: number;
  /** Where a temporary video goes. Defaults to the OS temp directory. */
  tempRoot?: string;
  now?: () => IsoDateTime;
};

export class ReelMediaRetrieval {
  private readonly options: Required<ReelMediaRetrievalOptions>;

  constructor(options: ReelMediaRetrievalOptions) {
    this.options = {
      ...options,
      tempRoot: options.tempRoot ?? tmpdir(),
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async run(itemId: ArchiveItemId): Promise<ReelMediaRun> {
    const { repository, storage, adapter, maxRetainedVideoBytes } = this.options;
    const aggregate = await repository.getArchiveItemAggregate(itemId);
    if (!aggregate) throw new Error(`Unknown archive item ${itemId}`);
    const { item } = aggregate;
    const now = this.options.now();

    await repository.enqueueMediaRetrieval(newRetrievalRequest(itemId, RETRIEVAL_PRIORITY.normal, now));
    const request = await repository.getMediaRetrievalRequest(itemId);
    if (!request) throw new Error(`No retrieval request for ${itemId}`);

    // Idempotency: an already stored Reel (either form) is not fetched again.
    const done = await completedRepresentation(storage, aggregate);
    if (request.status === "stored" && done) {
      return { request, representation: done.representation, assets: done.assets, alreadyComplete: true };
    }

    const fail = async (failure: RetrievalFailure): Promise<ReelMediaRun> => {
      const failed = recordRetrievalFailure(request, failure, now);
      await repository.saveMediaRetrievalRequest(failed);
      return { request: failed, assets: [], alreadyComplete: false };
    };

    const coverStored = await hasStoredCover(storage, aggregate);
    const outcome = await adapter.retrieve(item, { storedPositions: new Set(), coverStored });
    if (!outcome.ok) return fail(outcome.failure);
    const download = outcome.assets[0];
    const video = download?.result;
    if (!download || download.mediaType !== "video" || !video || video.ok === "already_stored") {
      return fail(temporary("The adapter returned no video"));
    }
    if (!video.ok) {
      if (video.failure.kind === "unavailable" && outcome.cover) {
        return this.storeCover(request, itemId, video.failure, outcome.cover, now);
      }
      return fail(video.failure);
    }
    const byteLength = video.bytes.byteLength;

    let assets: MediaAsset[];
    let representation: ReelRepresentation;
    if (byteLength <= maxRetainedVideoBytes) {
      // Canonical path: keep the video exactly as retrieved.
      const id = contentAssetId(itemId, 0);
      let storageKey: string;
      try {
        storageKey = (await storage.put(storageKeyFor(itemId, id, video.mimeType), video.bytes)).storageKey;
      } catch (error) {
        return fail({ kind: "temporary", code: "storage_error", message: messageOf(error) });
      }
      representation = "video";
      assets = [{
        id,
        archiveItemId: itemId,
        mediaType: "video",
        role: "content",
        position: 0,
        retrieval: {
          status: "stored",
          storageKey,
          mimeType: video.mimeType,
          retrievedAt: now,
          byteLength,
          ...dimensions(video),
        },
      }];
    } else {
      const frames = await this.framesFromTemporaryVideo(itemId, video, now);
      if (!frames.ok) return fail(frames.failure);
      representation = "frames";
      assets = frames.assets;
    }

    const stored = recordRetrievalSuccess(request, now);
    await repository.withTransaction(async (repo) => {
      await repo.saveMediaAssets(assets);
      if (item.kind === "unknown" && outcome.kind) {
        await repo.saveArchiveItem({ ...item, kind: outcome.kind, updatedAt: now });
      }
      await repo.saveMediaRetrievalRequest(stored);
    });
    return { request: stored, representation, assets, videoByteLength: byteLength, alreadyComplete: false };
  }

  /**
   * Cover path: the video is withheld, so its content asset records why, and
   * the cover image is stored as the item's `cover` (once). The request is
   * then done: all obtainable media is stored. A failed cover download leaves
   * the request to be retried like any temporary failure.
   */
  private async storeCover(
    request: MediaRetrievalRequest,
    itemId: ArchiveItemId,
    withheld: Extract<RetrievalFailure, { kind: "unavailable" }>,
    cover: RetrievedAsset["result"],
    now: IsoDateTime,
  ): Promise<ReelMediaRun> {
    const { repository, storage } = this.options;
    const videoAsset: MediaAsset = {
      id: contentAssetId(itemId, 0),
      archiveItemId: itemId,
      mediaType: "video",
      role: "content",
      position: 0,
      retrieval: { status: "unavailable", checkedAt: now, reason: withheld.code, detail: withheld.message },
    };
    const assets: MediaAsset[] = [videoAsset];
    let failure: RetrievalFailure | undefined;
    if (cover.ok === true) {
      const id = coverAssetId(itemId);
      try {
        const { storageKey } = await storage.put(storageKeyFor(itemId, id, cover.mimeType), cover.bytes);
        assets.push({
          id,
          archiveItemId: itemId,
          mediaType: "image",
          role: "cover",
          retrieval: {
            status: "stored",
            storageKey,
            mimeType: cover.mimeType,
            retrievedAt: now,
            byteLength: cover.bytes.byteLength,
            ...dimensions(cover),
          },
        });
      } catch (error) {
        failure = { kind: "temporary", code: "storage_error", message: messageOf(error) };
      }
    } else if (cover.ok === false) {
      failure = cover.failure;
    }

    const next = failure ? recordRetrievalFailure(request, failure, now) : recordRetrievalSuccess(request, now);
    await repository.withTransaction(async (repo) => {
      await repo.saveMediaAssets(assets);
      await repo.saveMediaRetrievalRequest(next);
    });
    return failure
      ? { request: next, assets, alreadyComplete: false }
      : { request: next, representation: "cover", assets, alreadyComplete: false };
  }

  /** Frames path: the video only ever exists in a temp directory. */
  private async framesFromTemporaryVideo(
    itemId: ArchiveItemId,
    video: { bytes: Uint8Array; mimeType: string; width?: number; height?: number; durationMs?: number },
    now: IsoDateTime,
  ): Promise<{ ok: true; assets: MediaAsset[] } | { ok: false; failure: RetrievalFailure }> {
    const { storage, extractor } = this.options;
    const derivedFrom = { mimeType: video.mimeType, byteLength: video.bytes.byteLength, ...dimensions(video) };
    const tempDir = await mkdtemp(join(this.options.tempRoot, "insta-archive-reel-"));
    try {
      const videoPath = join(tempDir, "video.mp4");
      await writeFile(videoPath, video.bytes);

      let extracted: ExtractedFrame[];
      try {
        extracted = await extractor.extract(videoPath, join(tempDir, "frames"), frameIntervalForVideoBytes(video.bytes.byteLength));
      } catch (error) {
        return { ok: false, failure: temporary(`Frame extraction failed: ${messageOf(error)}`) };
      }
      if (extracted.length === 0) return { ok: false, failure: temporary("Frame extraction produced no frames") };

      const assets: MediaAsset[] = [];
      for (const frame of [...extracted].sort((a, b) => a.frameTimeMs - b.frameTimeMs)) {
        const id = `${itemId}:frame:${frame.frameTimeMs}` as MediaAssetId;
        const bytes = await readFile(frame.path);
        let storageKey: string;
        try {
          storageKey = (await storage.put(storageKeyFor(itemId, id, frame.mimeType), bytes)).storageKey;
        } catch (error) {
          return { ok: false, failure: { kind: "temporary", code: "storage_error", message: messageOf(error) } };
        }
        assets.push({
          id,
          archiveItemId: itemId,
          mediaType: "image",
          role: "derived_frame",
          frameTimeMs: frame.frameTimeMs,
          retrieval: {
            status: "stored",
            storageKey,
            mimeType: frame.mimeType,
            retrievedAt: now,
            byteLength: bytes.byteLength,
            ...(frame.width !== undefined && { width: frame.width }),
            ...(frame.height !== undefined && { height: frame.height }),
            derivedFrom,
          },
        });
      }
      return { ok: true, assets };
    } finally {
      // The video is never retained on this path, whatever happened above.
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

/** The Reel's stored representation, if all of its files are present. */
async function completedRepresentation(
  storage: MediaStorage,
  aggregate: ArchiveItemAggregate,
): Promise<{ representation: ReelRepresentation; assets: MediaAsset[] } | undefined> {
  const video = aggregate.media.filter((m) => m.role === "content" && m.mediaType === "video");
  if (video.length > 0 && (await allStored(storage, video))) return { representation: "video", assets: video };
  const frames = aggregate.media.filter((m) => m.role === "derived_frame" && !m.derivedFromAssetId);
  if (frames.length > 0 && (await allStored(storage, frames))) return { representation: "frames", assets: frames };
  const cover = aggregate.media.filter((m) => m.role === "cover");
  if (cover.length > 0 && (await allStored(storage, cover))) return { representation: "cover", assets: cover };
  return undefined;
}

async function hasStoredCover(storage: MediaStorage, aggregate: ArchiveItemAggregate): Promise<boolean> {
  const cover = aggregate.media.filter((m) => m.role === "cover");
  return cover.length > 0 && (await allStored(storage, cover));
}

async function allStored(storage: MediaStorage, assets: MediaAsset[]): Promise<boolean> {
  for (const asset of assets) {
    if (asset.retrieval.status !== "stored" || !(await storage.has(asset.retrieval.storageKey))) return false;
  }
  return true;
}

function dimensions(video: { width?: number; height?: number; durationMs?: number }) {
  return {
    ...(video.width !== undefined && { width: video.width }),
    ...(video.height !== undefined && { height: video.height }),
    ...(video.durationMs !== undefined && { durationMs: video.durationMs }),
  };
}

function temporary(message: string): RetrievalFailure {
  return { kind: "temporary", code: "unknown", message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
