/**
 * SPIKE (Steps 08B.1–08B.5): retrieve the media of one existing ArchiveItem:
 * a single image, with --carousel every slide of a carousel, or with --reel a
 * Reel via the Reel media strategy (video kept if it is at most
 * REEL_MAX_RETAINED_VIDEO_BYTES, otherwise sampled frames; frames need ffmpeg).
 *
 *   npm run spike:instagram-image -- <shortcode> [--carousel | --reel]
 *     [--max-video-bytes n] [--owner-id local] [--database path] [--temp-dir path]
 *
 * Uses DATABASE_PATH, MEDIA_STORAGE_DIR and REEL_MAX_RETAINED_VIDEO_BYTES
 * (--max-video-bytes overrides the last one). Safe to re-run.
 */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import { InstagramCarouselSpikeAdapter } from "../media/instagram/instagram-carousel-spike-adapter.ts";
import { InstagramImageSpikeAdapter } from "../media/instagram/instagram-image-spike-adapter.ts";
import { InstagramReelSpikeAdapter } from "../media/instagram/instagram-reel-spike-adapter.ts";
import { FfmpegFrameExtractor } from "../media/instagram/ffmpeg-frame-extractor.ts";
import { ReelMediaRetrieval, reelMaxRetainedVideoBytesFromEnv } from "../media/instagram/reel-media.ts";
import { MediaRetrievalService } from "../media/media-retrieval-service.ts";
import { sha256 } from "../media/media-storage.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "owner-id": { type: "string", default: "local" },
      database: { type: "string" },
      carousel: { type: "boolean", default: false },
      reel: { type: "boolean", default: false },
      "max-video-bytes": { type: "string" },
      "temp-dir": { type: "string" },
    },
  });
  const [shortcode] = positionals;
  if (!shortcode || (values.carousel && values.reel)) {
    console.log("Usage: npm run spike:instagram-image -- <shortcode> [--carousel | --reel] [--max-video-bytes n] [--owner-id local] [--database path] [--temp-dir path]");
    return 1;
  }

  const mediaDir = mediaStorageDirFromEnv();
  const db = openDatabase(values.database ? resolve(values.database) : databasePathFromEnv());
  try {
    const repository = new SqliteArchiveRepository(db);
    const storage = new LocalMediaStorage(mediaDir);
    const service = new MediaRetrievalService({
      repository,
      storage,
      adapters: [values.carousel ? new InstagramCarouselSpikeAdapter() : new InstagramImageSpikeAdapter()],
    });

    const item = await repository.findArchiveItemByIdentity(values["owner-id"] as UserId, {
      kind: "shortcode",
      shortcode,
    });
    if (!item) {
      console.error(`No ArchiveItem for ${shortcode}; import an export containing it first.`);
      return 1;
    }

    if (values.reel) {
      const maxRetainedVideoBytes = reelMaxRetainedVideoBytesFromEnv(
        values["max-video-bytes"] ? { REEL_MAX_RETAINED_VIDEO_BYTES: values["max-video-bytes"] } : process.env,
      );
      const reels = new ReelMediaRetrieval({
        repository,
        storage,
        adapter: new InstagramReelSpikeAdapter(),
        extractor: new FfmpegFrameExtractor(),
        maxRetainedVideoBytes,
        ...(values["temp-dir"] && { tempRoot: resolve(values["temp-dir"]) }),
      });
      const result = await reels.run(item.id);
      console.log(`Item:      ${item.id} (${item.canonicalUrl})`);
      console.log(`Threshold: ${maxRetainedVideoBytes} bytes`);
      console.log(`Video:     ${result.videoByteLength ?? "not downloaded"}${result.videoByteLength === undefined ? "" : " bytes"}`);
      console.log(`Run:       ${result.alreadyComplete ? "already complete, nothing fetched" : `stored as ${result.representation ?? "nothing (failed)"}`}`);
      console.log(`Request:   ${JSON.stringify(result.request)}`);
      for (const asset of (await repository.getArchiveItemAggregate(item.id))?.media ?? []) {
        console.log(`Asset:     ${JSON.stringify(asset)}`);
      }
      return 0;
    }

    await service.enqueue(item.id);
    const run = await service.process(item.id);
    const aggregate = await repository.getArchiveItemAggregate(item.id);

    console.log(`Item:     ${item.id} (${item.canonicalUrl})`);
    console.log(`Kind:     ${item.kind} → ${aggregate?.item.kind}`);
    console.log(`Run:      ${run.alreadyStored ? "already stored, nothing fetched" : `${run.storedAssets} asset(s) stored`}`);
    console.log(`Request:  ${JSON.stringify(run.request, null, 2)}`);
    for (const asset of aggregate?.media ?? []) {
      console.log(`Asset:    ${JSON.stringify(asset, null, 2)}`);
      if (asset.retrieval.status === "stored") {
        const bytes = await storage.read(asset.retrieval.storageKey);
        console.log(`File:     ${join(mediaDir, asset.retrieval.storageKey)}`);
        console.log(`Bytes:    ${bytes.byteLength}, sha256 ${sha256(bytes)}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
