import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { UserId } from "../domain/archive-item.ts";
import { archiveDatabasePath, archiveMediaDir } from "../config/data-source.ts";
import { listArchiveCards } from "../archive-view/archive-view.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { placeholderPng, seedDemoArchive } from "./seed-demo.ts";

const OWNER = "local" as UserId;

describe("seeding the demo archive", () => {
  let dir: string;
  let env: Record<string, string>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-demo-"));
    // A stand-in personal archive next to the demo one: it must not be touched.
    mkdirSync(join(dir, "personal", "media"), { recursive: true });
    writeFileSync(join(dir, "personal", "archive.sqlite"), "personal database bytes");
    writeFileSync(join(dir, "personal", "media", "photo.jpg"), "personal photo bytes");
    env = {
      ARCHIVE_DATA_SOURCE: "demo",
      DATABASE_PATH: join(dir, "personal", "archive.sqlite"),
      MEDIA_STORAGE_DIR: join(dir, "personal", "media"),
      DEMO_DATABASE_PATH: join(dir, "demo", "archive.sqlite"),
      DEMO_MEDIA_STORAGE_DIR: join(dir, "demo", "media"),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = async () => {
    const db = openDatabase(archiveDatabasePath(env));
    try {
      const repository = new SqliteArchiveRepository(db);
      const summary = await seedDemoArchive({ repository, storage: new LocalMediaStorage(archiveMediaDir(env)), ownerId: OWNER, now: () => "2026-10-07T00:00:00.000Z" });
      const { cards } = await listArchiveCards(repository, OWNER, { pageSize: 100 });
      // Each card by its item's shortcode (the last part of its Details link).
      return { summary, cards: cards.map((c) => ({ ...c, shortcode: c.href.split("/").pop()! })) };
    } finally {
      db.close();
    }
  };

  test("fills the demo archive through the normal importer and repository, with media and media-less items", async () => {
    const { summary, cards } = await seed();
    assert.ok(summary.ingestion.files.length > 0);
    assert.equal(summary.images, 3);
    // The main archive's scope applies as usual: the liked-only demo post is not listed.
    assert.deepEqual(cards.map((c) => c.shortcode).sort(), ["BareDDD444", "CarouBBB222", "ReelAAA111", "ReplyEEE555"]);
    assert.equal(cards.find((c) => c.shortcode === "CarouBBB222")?.storedMediaCount, 2);
    assert.equal(cards.find((c) => c.shortcode === "ReelAAA111")?.storedMediaCount, 0);
  });

  test("writes only inside the demo locations; the personal archive's files are untouched", async () => {
    const before = [readFileSync(join(dir, "personal", "archive.sqlite"), "utf8"), readdirSync(join(dir, "personal", "media"))];
    const mtime = statSync(join(dir, "personal", "archive.sqlite")).mtimeMs;
    await seed();
    assert.deepEqual([readFileSync(join(dir, "personal", "archive.sqlite"), "utf8"), readdirSync(join(dir, "personal", "media"))], before);
    assert.equal(statSync(join(dir, "personal", "archive.sqlite")).mtimeMs, mtime);
    assert.ok(readdirSync(join(dir, "demo", "media"), { recursive: true }).length > 0);
  });

  test("re-seeding is idempotent", async () => {
    const rows = () => {
      const db = openDatabase(archiveDatabasePath(env));
      try {
        return ["archive_items", "source_records", "media_assets", "media_retrieval_requests"].map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      } finally {
        db.close();
      }
    };
    const first = (await seed()).cards.map((c) => c.shortcode);
    const counts = rows();
    const second = await seed();
    assert.deepEqual(second.cards.map((c) => c.shortcode), first);
    assert.deepEqual(rows(), counts, "nothing added twice");
  });

  test("placeholder images are valid PNGs", () => {
    const png = placeholderPng(4, 3, [200, 100, 50]);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = Buffer.from(png);
    assert.deepEqual([view.readUInt32BE(16), view.readUInt32BE(20)], [4, 3]);
  });
});
