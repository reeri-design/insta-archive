/**
 * Brings Reels stored as frames under the earlier strategy (dense PNG frames)
 * in line with the current one: at most 8 JPEG frames, chosen for scene
 * changes, without near-duplicates, black frames or end cards. Works from the
 * stored frames (the videos were never kept); fetches nothing.
 *
 *   npm run reprocess:reel-frames                 # read-only: what would change
 *   npm run reprocess:reel-frames -- --apply      # do it
 *
 * The old frames' files are listed, not deleted, so they can be checked and
 * removed deliberately. A Reel without a cover does not get one here.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { FfmpegFrameExtractor } from "../media/instagram/ffmpeg-frame-extractor.ts";
import { ReelFrameMigration } from "../media/instagram/reel-frame-migration.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run reprocess:reel-frames -- [options]

  --apply                Re-encode (default: only list what would change).
  --limit <n>            At most n Reels in this run.
  --owner-id <id>        Archive owner (default "local").
  --database <path>      SQLite file (default: DATABASE_PATH).
  --temp-dir <path>      Where temporary frames go (default: OS temp).
  -h, --help`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      limit: { type: "string" },
      "owner-id": { type: "string", default: "local" },
      database: { type: "string" },
      "temp-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (values.help || !(limit >= 1)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const db = openDatabase(values.database ? resolve(values.database) : databasePathFromEnv());
  try {
    const repository = new SqliteArchiveRepository(db);
    const migration = new ReelFrameMigration({
      repository,
      storage: new LocalMediaStorage(mediaStorageDirFromEnv()),
      reencoder: new FfmpegFrameExtractor(),
      ...(values["temp-dir"] && { tempRoot: resolve(values["temp-dir"]) }),
    });
    const plan = (await migration.plan(values["owner-id"] as UserId)).slice(0, limit);
    const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
    console.log(`${plan.length} Reel(s) with frames from the earlier strategy${values.apply ? "" : " (read-only; pass --apply to re-encode)"}:`);
    for (const p of plan) console.log(`  ${p.itemId}  ${p.frames} frames, ${mb(p.bytes)}, ${p.mimeTypes.join("/")}${p.hasCover ? ", has cover" : ", no cover"}`);
    if (!values.apply) return 0;

    let before = 0;
    let after = 0;
    const oldKeys: string[] = [];
    for (const p of plan) {
      const result = await migration.migrate(p.itemId);
      if (result.status === "migrated") {
        before += result.before.bytes;
        after += result.after.bytes;
        oldKeys.push(...result.oldStorageKeys);
        console.log(`  migrated ${p.itemId}: ${result.before.frames} → ${result.after.frames} frames, ${mb(result.before.bytes)} → ${mb(result.after.bytes)}`);
      } else {
        console.log(`  skipped  ${p.itemId}: ${result.reason}`);
      }
    }
    console.log(`\nFrames: ${mb(before)} → ${mb(after)}. ${oldKeys.length} old frame file(s) are no longer referenced (not deleted):`);
    for (const key of oldKeys) console.log(`  ${key}`);
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
