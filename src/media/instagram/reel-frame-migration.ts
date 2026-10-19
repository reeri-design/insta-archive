/**
 * Brings Reels stored as frames under the earlier strategy (dense PNG frames,
 * often dozens) in line with the current one (reel-media.ts): at most
 * MAX_DERIVED_FRAMES JPEG frames, chosen for scene changes, without
 * near-duplicates, black frames or end cards (frame-selection.ts).
 *
 * The original videos were never kept, so the new frames are chosen from the
 * stored ones, which already span each video. Nothing is fetched: a Reel's
 * cover, if it has none, is not added here.
 *
 * Safe by construction:
 *  - `plan` only reads;
 *  - `migrate` writes the new JPEG files first, then swaps the frame assets
 *    in one transaction (replaceReelFrames), and reports the old frames' files
 *    instead of deleting them, so they can be checked and removed deliberately;
 *  - a Reel already in the current form is left alone (rerunning is a no-op).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveItemAggregate, ArchiveItemId, IsoDateTime, MediaAsset, MediaAssetId, UserId } from "../../domain/archive-item.ts";
import type { ArchiveRepository } from "../../persistence/archive-repository.ts";
import { storageKeyFor, type MediaStorage } from "../media-storage.ts";
import { MAX_DERIVED_FRAMES } from "./frame-selection.ts";
import type { ExtractedFrame } from "./reel-media.ts";

/** Chooses representative frames among images and writes them as JPEG (see frame-selection.ts). */
export interface StoredFrameReencoder {
  /** `images` in time order; returns the chosen ones (at most `maxFrames`), keeping each image's `timeMs`. */
  representativeFromImages(images: { path: string; timeMs: number }[], outDir: string, options: { maxFrames: number }): Promise<ExtractedFrame[]>;
}

type ReelFrame = Extract<MediaAsset, { role: "derived_frame" }>;
type StoredReelFrame = ReelFrame & { retrieval: Extract<MediaAsset["retrieval"], { status: "stored" }> };

/** The Reel's stored frames standing in for a video that was not kept, in time order. */
function reelFrames(aggregate: ArchiveItemAggregate): StoredReelFrame[] {
  return aggregate.media
    .filter((m): m is StoredReelFrame => m.role === "derived_frame" && !m.derivedFromAssetId && m.retrieval.status === "stored")
    .sort((a, b) => a.frameTimeMs - b.frameTimeMs);
}

/** Frames from the earlier strategy: any frame that is not JPEG, or more than MAX_DERIVED_FRAMES of them. */
export function needsFrameMigration(aggregate: ArchiveItemAggregate): boolean {
  const frames = reelFrames(aggregate);
  return frames.length > 0 && (frames.length > MAX_DERIVED_FRAMES || frames.some((f) => f.retrieval.mimeType !== "image/jpeg"));
}

export type FrameMigrationPlanEntry = {
  itemId: ArchiveItemId;
  frames: number;
  bytes: number;
  mimeTypes: string[];
  hasCover: boolean;
};

export type FrameMigrationResult =
  | { itemId: ArchiveItemId; status: "migrated"; before: { frames: number; bytes: number }; after: { frames: number; bytes: number }; oldStorageKeys: string[] }
  | { itemId: ArchiveItemId; status: "skipped"; reason: string };

export type ReelFrameMigrationOptions = {
  repository: ArchiveRepository;
  storage: MediaStorage;
  reencoder: StoredFrameReencoder;
  tempRoot?: string;
  now?: () => IsoDateTime;
};

export class ReelFrameMigration {
  private readonly options: ReelFrameMigrationOptions;

  constructor(options: ReelFrameMigrationOptions) {
    this.options = options;
  }

  /** Read-only: the Reels whose frames still use the earlier strategy. */
  async plan(ownerId: UserId): Promise<FrameMigrationPlanEntry[]> {
    const { repository } = this.options;
    const entries: FrameMigrationPlanEntry[] = [];
    for (const itemId of await repository.listItemIdsWithReelFrames(ownerId)) {
      const aggregate = await repository.getArchiveItemAggregate(itemId);
      if (!aggregate || !needsFrameMigration(aggregate)) continue;
      const frames = reelFrames(aggregate);
      entries.push({
        itemId,
        frames: frames.length,
        bytes: frames.reduce((n, f) => n + (f.retrieval.byteLength ?? 0), 0),
        mimeTypes: [...new Set(frames.map((f) => f.retrieval.mimeType))],
        hasCover: aggregate.media.some((m) => m.role === "cover" && m.retrieval.status === "stored"),
      });
    }
    return entries;
  }

  /** Re-selects and re-encodes one Reel's frames; the old frames' files are reported, not deleted. */
  async migrate(itemId: ArchiveItemId): Promise<FrameMigrationResult> {
    const { repository, storage, reencoder } = this.options;
    const aggregate = await repository.getArchiveItemAggregate(itemId);
    if (!aggregate) return { itemId, status: "skipped", reason: "unknown item" };
    if (!needsFrameMigration(aggregate)) return { itemId, status: "skipped", reason: "already in the current form" };
    const old = reelFrames(aggregate);
    const now = (this.options.now ?? (() => new Date().toISOString()))();

    const tempDir = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "insta-archive-frames-"));
    try {
      const images: { path: string; timeMs: number }[] = [];
      for (const [i, frame] of old.entries()) {
        const path = join(tempDir, `in_${String(i).padStart(3, "0")}.${frame.retrieval.mimeType === "image/jpeg" ? "jpg" : "png"}`);
        await writeFile(path, await storage.read(frame.retrieval.storageKey));
        images.push({ path, timeMs: frame.frameTimeMs });
      }
      const chosen = await reencoder.representativeFromImages(images, join(tempDir, "out"), { maxFrames: MAX_DERIVED_FRAMES });
      const times = chosen.map((f) => f.frameTimeMs);
      if (chosen.length === 0) return { itemId, status: "skipped", reason: "no useful frames among the stored ones" };
      if (chosen.length > MAX_DERIVED_FRAMES || new Set(times).size !== times.length || chosen.some((f) => f.mimeType !== "image/jpeg")) {
        throw new Error(`The re-encoder returned an invalid frame set for ${itemId}`);
      }
      const byTime = new Map(old.map((f) => [f.frameTimeMs, f]));

      const frames: MediaAsset[] = [];
      for (const frame of [...chosen].sort((a, b) => a.frameTimeMs - b.frameTimeMs)) {
        const source = byTime.get(frame.frameTimeMs);
        if (!source) throw new Error(`The re-encoder returned a frame at ${frame.frameTimeMs} ms, which is not a stored frame`);
        const id = `${itemId}:frame:${frame.frameTimeMs}` as MediaAssetId;
        const bytes = await readFile(frame.path);
        const { storageKey } = await storage.put(storageKeyFor(itemId, id, "image/jpeg"), bytes);
        frames.push({
          id,
          archiveItemId: itemId,
          mediaType: "image",
          role: "derived_frame",
          frameTimeMs: frame.frameTimeMs,
          retrieval: {
            status: "stored",
            storageKey,
            mimeType: "image/jpeg",
            retrievedAt: now,
            byteLength: bytes.byteLength,
            ...(frame.width !== undefined && { width: frame.width }),
            ...(frame.height !== undefined && { height: frame.height }),
            ...(source.retrieval.derivedFrom && { derivedFrom: source.retrieval.derivedFrom }),
          },
        });
      }
      await repository.replaceReelFrames(itemId, frames);
      const newKeys = new Set(frames.map((f) => (f.retrieval as { storageKey: string }).storageKey));
      return {
        itemId,
        status: "migrated",
        before: { frames: old.length, bytes: old.reduce((n, f) => n + (f.retrieval.byteLength ?? 0), 0) },
        after: { frames: frames.length, bytes: frames.reduce((n, f) => n + (f.retrieval as { byteLength: number }).byteLength, 0) },
        oldStorageKeys: old.map((f) => f.retrieval.storageKey).filter((k) => !newKeys.has(k)),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
