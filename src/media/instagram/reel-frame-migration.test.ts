import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, MediaAsset, MediaAssetId, UserId } from "../../domain/archive-item.ts";
import { ingestInstagramExport } from "../../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { LocalMediaStorage } from "../local-media-storage.ts";
import { storageKeyFor } from "../media-storage.ts";
import { needsFrameMigration, ReelFrameMigration, type StoredFrameReencoder } from "./reel-frame-migration.ts";
import type { ExtractedFrame } from "./reel-media.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const ITEM_ID = "owner-1:shortcode:ReelAAA111" as ArchiveItemId;
const DERIVED_FROM = { mimeType: "video/mp4", byteLength: 23_000_000, width: 1080, height: 1920, durationMs: 60_000 };

/** Keeps every `step`-th image (the real one chooses by content); writes small JPEG-named files. */
class FakeReencoder implements StoredFrameReencoder {
  calls = 0;
  private readonly step: number;
  constructor(step: number) {
    this.step = step;
  }
  async representativeFromImages(images: { path: string; timeMs: number }[], outDir: string, options: { maxFrames: number }): Promise<ExtractedFrame[]> {
    this.calls++;
    mkdirSync(outDir, { recursive: true });
    return images
      .filter((_, i) => i % this.step === 0)
      .slice(0, options.maxFrames)
      .map((image, k) => {
        const path = join(outDir, `f${k}.jpg`);
        writeFileSync(path, `jpeg ${image.timeMs}`);
        return { frameTimeMs: image.timeMs, path, mimeType: "image/jpeg", width: 720, height: 1280 };
      });
  }
}

describe("migrating Reels stored as frames under the earlier strategy", () => {
  let dir: string;
  let db: DatabaseSync;
  let repo: SqliteArchiveRepository;
  let storage: LocalMediaStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-frame-migration-"));
    db = openDatabase(join(dir, "test.sqlite"));
    repo = new SqliteArchiveRepository(db);
    storage = new LocalMediaStorage(join(dir, "media"));
    await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: "2026-10-02T00:00:00.000Z" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `count` PNG frames every 4 s, as the earlier strategy stored them. */
  const storeLegacyFrames = async (count: number, mimeType = "image/png") => {
    const assets: MediaAsset[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${ITEM_ID}:frame:${i * 4000}` as MediaAssetId;
      const { storageKey } = await storage.put(storageKeyFor(ITEM_ID, id, mimeType), new TextEncoder().encode(`old frame ${i}`.padEnd(100, ".")));
      assets.push({
        id, archiveItemId: ITEM_ID, mediaType: "image", role: "derived_frame", frameTimeMs: i * 4000,
        retrieval: { status: "stored", storageKey, mimeType, retrievedAt: "2026-10-04T00:00:00.000Z", byteLength: 100, width: 720, height: 1280, derivedFrom: DERIVED_FROM },
      });
    }
    await repo.saveMediaAssets(assets);
    return assets;
  };
  const migration = (reencoder: StoredFrameReencoder) =>
    new ReelFrameMigration({ repository: repo, storage, reencoder, tempRoot: dir, now: () => "2026-10-06T12:00:00.000Z" });
  const frames = async () => ((await repo.getArchiveItemAggregate(ITEM_ID))?.media ?? []).filter((m) => m.role === "derived_frame");

  test("the plan only reads, and lists Reels with PNG frames or more than 8", async () => {
    await storeLegacyFrames(17);
    const before = await frames();
    const reencoder = new FakeReencoder(2);
    const plan = await migration(reencoder).plan(OWNER);
    assert.deepEqual(plan, [{ itemId: ITEM_ID, frames: 17, bytes: 1700, mimeTypes: ["image/png"], hasCover: false }]);
    assert.deepEqual(await frames(), before, "the plan changes nothing");
    assert.equal(reencoder.calls, 0);
  });

  test("migrating keeps at most 8 JPEG frames from the stored ones, and reports — never deletes — the old files", async () => {
    const old = await storeLegacyFrames(17);
    const result = await migration(new FakeReencoder(2)).migrate(ITEM_ID);
    assert.equal(result.status, "migrated");
    if (result.status !== "migrated") return;
    assert.deepEqual(result.before, { frames: 17, bytes: 1700 });
    assert.equal(result.after.frames, 8);

    const now = await frames();
    assert.equal(now.length, 8);
    for (const frame of now) {
      assert.ok(frame.retrieval.status === "stored" && frame.retrieval.mimeType === "image/jpeg");
      if (frame.retrieval.status !== "stored") continue;
      assert.deepEqual(frame.retrieval.derivedFrom, DERIVED_FROM, "still records the video it stands in for");
      assert.ok(await storage.has(frame.retrieval.storageKey));
    }
    assert.deepEqual(now.map((f) => f.role === "derived_frame" && f.frameTimeMs), [0, 8000, 16000, 24000, 32000, 40000, 48000, 56000]);
    // Every old PNG file is still there, and reported for deliberate cleanup.
    assert.equal(result.oldStorageKeys.length, 17);
    for (const asset of old) assert.ok(existsSync(join(dir, "media", (asset.retrieval as { storageKey: string }).storageKey)));
  });

  test("a Reel already in the current form is left alone; rerunning is a no-op", async () => {
    await storeLegacyFrames(17);
    const reencoder = new FakeReencoder(2);
    await migration(reencoder).migrate(ITEM_ID);
    const again = await migration(reencoder).migrate(ITEM_ID);
    assert.deepEqual(again, { itemId: ITEM_ID, status: "skipped", reason: "already in the current form" });
    assert.equal(reencoder.calls, 1);
    assert.deepEqual(await migration(reencoder).plan(OWNER), []);
  });

  test("few JPEG frames need nothing; a few PNG frames are still re-encoded", async () => {
    await storeLegacyFrames(5, "image/jpeg");
    assert.equal(needsFrameMigration((await repo.getArchiveItemAggregate(ITEM_ID))!), false);
    rmSync(join(dir, "media"), { recursive: true, force: true });
    db.exec("DELETE FROM media_assets");
    await storeLegacyFrames(5, "image/png");
    assert.equal(needsFrameMigration((await repo.getArchiveItemAggregate(ITEM_ID))!), true);
  });

  test("replacing frames is all-or-nothing and touches no other asset", async () => {
    await storeLegacyFrames(3);
    const cover: MediaAsset = {
      id: `${ITEM_ID}:cover` as MediaAssetId, archiveItemId: ITEM_ID, mediaType: "image", role: "cover",
      retrieval: { status: "stored", storageKey: "c/cover.jpg", mimeType: "image/jpeg", retrievedAt: "2026-10-04T00:00:00.000Z", byteLength: 10 },
    };
    await repo.saveMediaAssets([cover]);
    await assert.rejects(repo.replaceReelFrames(ITEM_ID, [cover]), /derived frames/);
    assert.equal((await frames()).length, 3, "a rejected replacement changes nothing");
    await repo.replaceReelFrames(ITEM_ID, []);
    const media = (await repo.getArchiveItemAggregate(ITEM_ID))?.media ?? [];
    assert.deepEqual(media.map((m) => m.role), ["cover"]);
    assert.deepEqual(await repo.listItemIdsWithReelFrames(OWNER), []);
  });
});
