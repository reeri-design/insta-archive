import { createHash } from "node:crypto";
import type { ArchiveItemId, MediaAssetId } from "../domain/archive-item.ts";

/**
 * Where original media bytes live (never in SQLite). Bytes are stored exactly
 * as given: no re-encoding, resizing or metadata stripping.
 */
export interface MediaStorage {
  /**
   * Store bytes under `key`. Storing identical bytes again is a no-op;
   * different bytes under an existing key are refused, so an original is
   * never overwritten.
   * @throws MediaStorageConflictError
   */
  put(key: string, bytes: Uint8Array): Promise<StoredMedia>;
  has(key: string): Promise<boolean>;
  read(key: string): Promise<Uint8Array>;
}

export type StoredMedia = {
  storageKey: string;
  byteLength: number;
  sha256: string;
};

export class MediaStorageConflictError extends Error {
  override name = "MediaStorageConflictError";
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

/**
 * Stable key for an asset: the same item, asset and type always map to the
 * same key, so "is it already stored?" can be answered before downloading.
 * Ids are hashed to keep keys filesystem-safe.
 */
export function storageKeyFor(
  itemId: ArchiveItemId,
  assetId: MediaAssetId,
  mimeType: string,
): string {
  const item = sha256(itemId).slice(0, 32);
  const asset = sha256(assetId).slice(0, 32);
  return `${item.slice(0, 2)}/${item}/${asset}${EXTENSIONS[mimeType] ?? ".bin"}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
