/**
 * Retrieves media for a limited batch of ArchiveItems from Instagram.
 * Resumable: run it again to continue. Stops early on a rate limit.
 *
 *   npm run retrieve:media -- --limit 20 [options]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import { FfmpegFrameExtractor } from "../media/instagram/ffmpeg-frame-extractor.ts";
import { InstagramItemRetriever } from "../media/instagram/instagram-item-retriever.ts";
import { reelMaxRetainedVideoBytesFromEnv } from "../media/instagram/reel-media.ts";
import { MediaRetrievalJob, type MediaRetrievalJobSummary } from "../media/media-retrieval-job.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run retrieve:media -- --limit <n> [options]

  --limit <n>            Required. Items to attempt in this run (start small).
  --from-priority <n>    Only requests with priority <= n (100 = owner exchange, 0 = normal).
  --delay-ms <ms>        Pause between items (default 2000).
  --owner-id <id>        Archive owner (default "local").
  --database <path>      SQLite file (default: DATABASE_PATH).
  --temp-dir <path>      Where temporary Reel videos go (default: OS temp).
  -h, --help

Media goes to MEDIA_STORAGE_DIR; Reels larger than REEL_MAX_RETAINED_VIDEO_BYTES
(default 10 MB) are kept as up to 8 JPEG frames plus the cover (needs ffmpeg).`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      "from-priority": { type: "string" },
      "delay-ms": { type: "string", default: "2000" },
      "owner-id": { type: "string", default: "local" },
      database: { type: "string" },
      "temp-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const limit = Number(values.limit);
  const delayMs = Number(values["delay-ms"]);
  const maxPriority = values["from-priority"] === undefined ? undefined : Number(values["from-priority"]);
  if (values.help || !Number.isSafeInteger(limit) || limit < 1 || !(delayMs >= 0) || (maxPriority !== undefined && !Number.isFinite(maxPriority))) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const db = openDatabase(values.database ? resolve(values.database) : databasePathFromEnv());
  try {
    const repository = new SqliteArchiveRepository(db);
    const job = new MediaRetrievalJob({
      repository,
      delayMs,
      retriever: new InstagramItemRetriever({
        repository,
        storage: new LocalMediaStorage(mediaStorageDirFromEnv()),
        extractor: new FfmpegFrameExtractor(),
        maxRetainedVideoBytes: reelMaxRetainedVideoBytesFromEnv(),
        ...(values["temp-dir"] && { tempRoot: resolve(values["temp-dir"]) }),
      }),
    });
    const summary = await job.run({
      ownerId: values["owner-id"] as UserId,
      limit,
      ...(maxPriority !== undefined && { maxPriority }),
    });
    console.log(formatSummary(summary));
    return 0;
  } finally {
    db.close();
  }
}

function formatSummary(s: MediaRetrievalJobSummary): string {
  const status = (c: MediaRetrievalJobSummary["statusBefore"]) =>
    `stored ${c.stored}, unavailable ${c.unavailable}, failed ${c.failed}, pending ${c.pending}`;
  const lines = s.items.map((i, n) =>
    `${String(n + 1).padStart(3)}. ${i.outcome.padEnd(12)} ${(i.mediaType ?? "-").padEnd(13)} ${i.itemId}${i.detail ? `  (${i.detail})` : ""}`);
  return [
    ...lines,
    "",
    `Attempted:        ${s.attempted}`,
    `Stored:           ${s.stored}`,
    `Unavailable:      ${s.unavailable}`,
    `Failed/retryable: ${s.failed}`,
    `Errors:           ${s.errors}`,
    `Already stored:   ${s.alreadyStored} (skipped)`,
    `Rate limited:     ${s.rateLimited ? "yes, stopped early" : "no"}`,
    `Remaining due:    ${s.remainingDue}`,
    `Requests before:  ${status(s.statusBefore)}${s.enqueued ? ` (${s.enqueued} newly created)` : ""}`,
    `Requests after:   ${status(s.statusAfter)}`,
    `Duration:         ${(s.durationMs / 1000).toFixed(1)} s`,
  ].join("\n");
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
