/**
 * Seeds the demo archive with a tiny placeholder dataset (see src/demo/seed-demo.ts).
 * Only ever touches the demo archive: it refuses to run unless
 * ARCHIVE_DATA_SOURCE=demo, and the demo locations are checked to be apart
 * from the personal archive's (src/config/data-source.ts).
 *
 *   npm run demo:seed              # seed (re-running is safe: imports are idempotent)
 *   npm run demo:seed -- --reset   # delete the demo archive first, then seed
 */
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { archiveDatabasePath, archiveMediaDir, dataSourceFromEnv } from "../config/data-source.ts";
import { seedDemoArchive } from "../demo/seed-demo.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run demo:seed -- [--reset]

  --reset          Delete the demo database and media first.
  --owner-id <id>  Archive owner (default "local", as the app uses).
  -h, --help

Writes to DEMO_DATABASE_PATH / DEMO_MEDIA_STORAGE_DIR (default ./demo-data/).`;

function main(): Promise<number> | number {
  const { values } = parseArgs({
    options: {
      reset: { type: "boolean", default: false },
      "owner-id": { type: "string", default: "local" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (dataSourceFromEnv() !== "demo") {
    console.error("Refusing to seed: ARCHIVE_DATA_SOURCE is not \"demo\" (use npm run demo:seed). The personal archive is never seeded.");
    return 1;
  }
  // Both resolve to the demo locations and fail if those overlap the personal archive's.
  const databasePath = archiveDatabasePath();
  const mediaDir = archiveMediaDir();
  return seed(databasePath, mediaDir, values.reset, values["owner-id"] as UserId);
}

async function seed(databasePath: string, mediaDir: string, reset: boolean, ownerId: UserId): Promise<number> {
  if (reset) {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) rmSync(path, { force: true });
    rmSync(mediaDir, { recursive: true, force: true });
  }
  const db = openDatabase(databasePath);
  try {
    const summary = await seedDemoArchive({ repository: new SqliteArchiveRepository(db), storage: new LocalMediaStorage(mediaDir), ownerId });
    const imported = summary.ingestion.files.reduce((n, f) => n + f.imported, 0);
    console.log(`Demo archive seeded: ${imported} source records imported, ${summary.images} placeholder images.`);
    console.log(`  database: ${databasePath}\n  media:    ${mediaDir}`);
    return 0;
  } finally {
    db.close();
  }
}

Promise.resolve(main()).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
