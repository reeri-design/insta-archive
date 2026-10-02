import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  MediaStorageConflictError,
  sha256,
  type MediaStorage,
  type StoredMedia,
} from "./media-storage.ts";

/** MediaStorage on the local filesystem, rooted at one directory. */
export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Uint8Array): Promise<StoredMedia> {
    const path = this.pathFor(key);
    const stored: StoredMedia = { storageKey: key, byteLength: bytes.byteLength, sha256: sha256(bytes) };

    if (await this.has(key)) {
      if (sha256(await readFile(path)) === stored.sha256) return stored;
      throw new MediaStorageConflictError(`Different media is already stored under ${key}`);
    }

    // Write to a temp file and rename, so a crash never leaves a partial file
    // under the real key.
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return stored;
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  private pathFor(key: string): string {
    const normalized = normalize(key);
    if (isAbsolute(normalized) || normalized.startsWith("..") || normalized.split(sep).includes("..")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return join(this.root, normalized);
  }
}

/** MEDIA_STORAGE_DIR (see .env.example), resolved against the cwd. */
export function mediaStorageDirFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = env.MEDIA_STORAGE_DIR;
  if (!dir) throw new Error("MEDIA_STORAGE_DIR is not set (see .env.example)");
  return resolve(dir);
}
