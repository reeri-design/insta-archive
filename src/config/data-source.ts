/**
 * Which archive the app and the CLIs work on, and where it lives.
 *
 *   personal  The user's own archive (the default): DATABASE_PATH and
 *             MEDIA_STORAGE_DIR, exactly as before.
 *   demo      A small seeded demo archive, kept entirely apart:
 *             DEMO_DATABASE_PATH and DEMO_MEDIA_STORAGE_DIR, by default
 *             under ./demo-data/ (git-ignored).
 *
 * Selected by ARCHIVE_DATA_SOURCE ("personal" when unset). This is the only
 * place the choice is made: databasePathFromEnv() and
 * mediaStorageDirFromEnv(), which every entry point already uses, resolve
 * through it, so nothing else needs to know which archive is open.
 *
 * Safeguard: whatever the configuration, the two archives never share a
 * location. A database (or the folder it sits in) or media directory of one
 * source that equals, lies inside, or contains a location of the other is
 * refused, in either mode.
 *
 * Pure apart from reading the filesystem to resolve symlinks of existing paths.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export type DataSource = "personal" | "demo";

export const DATA_SOURCES: readonly DataSource[] = ["personal", "demo"];

/** Where the demo archive lives unless DEMO_DATABASE_PATH / DEMO_MEDIA_STORAGE_DIR say otherwise. */
export const DEFAULT_DEMO_DATABASE_PATH = "./demo-data/archive.sqlite";
export const DEFAULT_DEMO_MEDIA_STORAGE_DIR = "./demo-data/media";

type Env = Readonly<Record<string, string | undefined>>;

export class DataSourceConfigError extends Error {
  override name = "DataSourceConfigError";
}

/** The selected data source: ARCHIVE_DATA_SOURCE, "personal" when unset. */
export function dataSourceFromEnv(env: Env = process.env): DataSource {
  const raw = env.ARCHIVE_DATA_SOURCE?.trim();
  if (!raw) return "personal";
  if (!(DATA_SOURCES as readonly string[]).includes(raw)) {
    throw new DataSourceConfigError(`ARCHIVE_DATA_SOURCE must be "personal" or "demo", got "${raw}"`);
  }
  return raw as DataSource;
}

/** Each source's configured locations (undefined when not set). */
function configured(env: Env): Record<DataSource, { database?: string; media?: string }> {
  return {
    personal: {
      ...(env.DATABASE_PATH && { database: resolve(env.DATABASE_PATH) }),
      ...(env.MEDIA_STORAGE_DIR && { media: resolve(env.MEDIA_STORAGE_DIR) }),
    },
    demo: {
      database: resolve(env.DEMO_DATABASE_PATH || DEFAULT_DEMO_DATABASE_PATH),
      media: resolve(env.DEMO_MEDIA_STORAGE_DIR || DEFAULT_DEMO_MEDIA_STORAGE_DIR),
    },
  };
}

/**
 * What a source occupies: its database, the folder that database sits in
 * (its -wal and -shm files live there too), and its media directory.
 */
function occupied(location: { database?: string; media?: string }): Record<string, string> {
  return {
    ...(location.database && { database: location.database, "database folder": dirname(location.database) }),
    ...(location.media && { media: location.media }),
  };
}

/** The real path, following symlinks where the path (or a parent) exists. */
function canonical(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...rest);
}

/** Whether two locations coincide or one lies inside the other. */
function overlap(a: string, b: string): boolean {
  const [x, y] = [canonical(a), canonical(b)];
  const inside = (child: string, parent: string) => {
    const r = relative(parent, child);
    return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !r.startsWith(sep));
  };
  return inside(x, y) || inside(y, x);
}

/**
 * Refuses configurations where the personal and demo archives could touch
 * each other's files: nothing one source occupies may equal, contain or lie
 * inside the other's database or media. Checked whenever a location is
 * resolved, in both modes.
 */
export function assertSourcesSeparate(env: Env = process.env): void {
  const { personal, demo } = configured(env);
  const pairs: [Record<string, string>, Record<string, string>][] = [
    [occupied(personal), { ...demo }],
    [{ ...personal }, occupied(demo)],
  ];
  for (const [mine, theirs] of pairs) {
    for (const [pk, p] of Object.entries(mine)) {
      for (const [dk, d] of Object.entries(theirs)) {
        if (overlap(p, d)) {
          throw new DataSourceConfigError(
            `The personal archive's ${pk} (${p}) and the demo archive's ${dk} (${d}) overlap; they must be kept apart`,
          );
        }
      }
    }
  }
}

/** The selected archive's SQLite file. */
export function archiveDatabasePath(env: Env = process.env): string {
  const source = dataSourceFromEnv(env);
  assertSourcesSeparate(env);
  const path = configured(env)[source].database;
  if (!path) throw new DataSourceConfigError("DATABASE_PATH is not set (see .env.example)");
  return path;
}

/** The selected archive's media directory. */
export function archiveMediaDir(env: Env = process.env): string {
  const source = dataSourceFromEnv(env);
  assertSourcesSeparate(env);
  const dir = configured(env)[source].media;
  if (!dir) throw new DataSourceConfigError("MEDIA_STORAGE_DIR is not set (see .env.example)");
  return dir;
}
