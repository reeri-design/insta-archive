import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveDatabasePath } from "../../config/data-source.ts";
import { MIGRATIONS } from "./migrations.ts";

/**
 * Open (creating if needed) a SQLite database and bring its schema up to
 * date. Pass ":memory:" for a throwaway database.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/**
 * The selected archive's database (see src/config/data-source.ts): DATABASE_PATH
 * for the personal archive (the default), DEMO_DATABASE_PATH for the demo one;
 * resolved against the cwd. Refuses configurations where the two overlap.
 */
export function databasePathFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return archiveDatabasePath(env);
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this code (${MIGRATIONS.length})`,
    );
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version - 1];
    if (sql === undefined) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
