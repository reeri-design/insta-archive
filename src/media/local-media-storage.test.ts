import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, MediaAssetId } from "../domain/archive-item.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "./local-media-storage.ts";
import { MediaStorageConflictError, sha256, storageKeyFor } from "./media-storage.ts";

const ITEM = "owner-1:shortcode:X1" as ArchiveItemId;
const ASSET = "owner-1:shortcode:X1:media:0" as MediaAssetId;

let root: string;
let storage: LocalMediaStorage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "insta-archive-media-"));
  storage = new LocalMediaStorage(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("storage keys", () => {
  test("are stable for the same item, asset and type, and differ otherwise", () => {
    const key = storageKeyFor(ITEM, ASSET, "image/jpeg");
    assert.equal(key, storageKeyFor(ITEM, ASSET, "image/jpeg"));
    assert.match(key, /^[0-9a-f]{2}\/[0-9a-f]{32}\/[0-9a-f]{32}\.jpg$/);
    assert.notEqual(key, storageKeyFor(ITEM, "other" as MediaAssetId, "image/jpeg"));
    assert.notEqual(key, storageKeyFor("owner-2:shortcode:X1" as ArchiveItemId, ASSET, "image/jpeg"));
    assert.match(storageKeyFor(ITEM, ASSET, "video/mp4"), /\.mp4$/);
    assert.match(storageKeyFor(ITEM, ASSET, "application/x-unknown"), /\.bin$/);
  });
});

describe("LocalMediaStorage", () => {
  test("stores the exact bytes on disk under the key", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x4a, 0x46]);
    const key = storageKeyFor(ITEM, ASSET, "image/jpeg");
    assert.equal(await storage.has(key), false);

    const stored = await storage.put(key, bytes);
    assert.deepEqual(stored, { storageKey: key, byteLength: 7, sha256: sha256(bytes) });
    assert.equal(await storage.has(key), true);
    assert.deepEqual(new Uint8Array(readFileSync(join(root, key))), bytes);
    assert.deepEqual(await storage.read(key), bytes);
  });

  test("storing identical bytes again is a no-op; different bytes are refused", async () => {
    const key = storageKeyFor(ITEM, ASSET, "image/jpeg");
    await storage.put(key, new Uint8Array([1, 2, 3]));
    await storage.put(key, new Uint8Array([1, 2, 3]));
    await assert.rejects(storage.put(key, new Uint8Array([9, 9, 9])), MediaStorageConflictError);
    assert.deepEqual(await storage.read(key), new Uint8Array([1, 2, 3]));
  });

  test("keys cannot escape the storage root", async () => {
    await assert.rejects(storage.put("../escape.jpg", new Uint8Array([1])), /Invalid storage key/);
    await assert.rejects(storage.put("/etc/x", new Uint8Array([1])), /Invalid storage key/);
  });

  test("MEDIA_STORAGE_DIR is required", () => {
    assert.throws(() => mediaStorageDirFromEnv({}), /MEDIA_STORAGE_DIR is not set/);
    assert.equal(mediaStorageDirFromEnv({ MEDIA_STORAGE_DIR: "/tmp/m" }), "/tmp/m");
  });
});
