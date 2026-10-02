/**
 * Imports an Instagram "Download your information" JSON export into the
 * archive database. Parses Liked, Saved and Messages; never downloads media
 * or calls AI. Safe to re-run.
 *
 *   npm run import:instagram -- <export-dir> [options]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import {
  formatIngestionSummary,
  ingestInstagramExport,
} from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run import:instagram -- <export-dir> [options]

  <export-dir>                 Unpacked export (or its your_instagram_activity folder)

Options:
  --owner-id <id>              Archive owner id (default: "local"). Keep it stable
                               across imports; items are deduplicated per owner.
  --owner-sender-name <name>   A sender_name that is also the owner, e.g. your
                               other Instagram account. Repeatable.
  --export-id <id>             Label stored on each record's export location.
  --database <path>            SQLite file (default: DATABASE_PATH).
  -h, --help`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "owner-id": { type: "string", default: "local" },
      "owner-sender-name": { type: "string", multiple: true },
      "export-id": { type: "string" },
      database: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [exportDir, ...extra] = positionals;
  if (values.help || !exportDir || extra.length > 0) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const databasePath = values.database ? resolve(values.database) : databasePathFromEnv();
  const directory = readExportDirectory(resolve(exportDir));
  if (directory.files.length === 0) {
    console.error(`No Liked, Saved or Messages JSON files found under ${resolve(exportDir)}`);
    return 1;
  }

  const db = openDatabase(databasePath);
  try {
    const summary = await ingestInstagramExport(
      new SqliteArchiveRepository(db),
      directory.files,
      {
        ownerId: values["owner-id"] as UserId,
        importedAt: new Date().toISOString(),
        ...(values["export-id"] && { exportId: values["export-id"] }),
        ...(values["owner-sender-name"] && { ownerSenderNames: values["owner-sender-name"] }),
      },
      directory.unreadableFiles,
    );
    console.log(`Imported ${resolve(exportDir)}\nDatabase: ${databasePath}\n`);
    console.log(formatIngestionSummary(summary));
    return 0;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`Import failed; nothing was written.\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
