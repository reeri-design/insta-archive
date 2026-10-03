/**
 * Server-side wiring for the web app: the configured archive repository and
 * media storage (DATABASE_PATH, MEDIA_STORAGE_DIR). Import only from server
 * code (pages, route handlers, server actions).
 */
import type { DatabaseSync } from "node:sqlite";
import type { UserId } from "../domain/archive-item.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import type { MediaStorage } from "../media/media-storage.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

/** The archive owner. Single user for now, same default as the CLIs. */
export const OWNER_ID = "local" as UserId;

// Only the database connection is kept on globalThis, so development reloads
// reuse one connection. The repository and storage objects are module-scoped:
// a reload re-creates them from the current code. (Caching them on globalThis
// kept instances of an older class alive, without methods added since.)
const cache = globalThis as typeof globalThis & { archiveDatabase?: DatabaseSync };
let repository: ArchiveRepository | undefined;
let storage: MediaStorage | undefined;

export function archiveRepository(): ArchiveRepository {
  cache.archiveDatabase ??= openDatabase(databasePathFromEnv());
  repository ??= new SqliteArchiveRepository(cache.archiveDatabase);
  return repository;
}

export function mediaStorage(): MediaStorage {
  storage ??= new LocalMediaStorage(mediaStorageDirFromEnv());
  return storage;
}
