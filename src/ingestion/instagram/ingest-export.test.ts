import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, UserId } from "../../domain/archive-item.ts";
import { importInstagramExport } from "../../importers/instagram/import-export.ts";
import type { ExportFile, ImportOptions } from "../../importers/instagram/types.ts";
import {
  ArchiveIdentityConflictError,
  type ArchiveRepository,
} from "../../persistence/archive-repository.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { formatIngestionSummary, ingestInstagramExport } from "./ingest-export.ts";
import { readExportDirectory } from "./read-export-directory.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const THREAD = "your_instagram_activity/messages/inbox/friend_1234567890/message_1.json";
const LIKED = "your_instagram_activity/likes/liked_posts.json";
const OWNER = "owner-1" as UserId;
const OPTIONS: ImportOptions = { ownerId: OWNER, importedAt: "2026-10-01T09:00:00.000Z", exportId: "e1" };
const LATER: ImportOptions = { ...OPTIONS, importedAt: "2026-10-02T09:00:00.000Z" };

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-ingest-"));
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const fixtureFiles = () => readExportDirectory(FIXTURES).files;
const only = (...paths: string[]) => fixtureFiles().filter((f) => paths.includes(f.path));
const itemId = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;

/** Every row of every table, for before/after comparisons. */
function snapshot() {
  const tables = ["archive_items", "source_records", "original_metadata", "media_assets", "ai_organizations", "curated_organizations"];
  return Object.fromEntries(
    tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]),
  );
}
const rowCount = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("end-to-end import", () => {
  test("persists exactly what the importer produced", async () => {
    const files = fixtureFiles();
    const summary = await ingestInstagramExport(repo, files, OPTIONS);

    assert.equal(summary.sourceRecordsSeen, 9);
    assert.equal(summary.uniqueItems, 5);
    assert.equal(summary.multiSourceItems, 2);
    assert.equal(summary.crossSourceItems, 2);
    assert.equal(summary.newItems, 5);
    assert.equal(summary.newSourceRecords, 9);
    assert.equal(summary.skipped.length, 2);
    assert.equal(rowCount("archive_items"), 5);
    assert.equal(rowCount("source_records"), 9);
    assert.equal(rowCount("media_assets"), 0);
    assert.equal(rowCount("ai_organizations"), 0);

    // Identity, kind, canonical URL, sources (URLs, timestamps, creators,
    // shared text, message context, raw JSON, export location) and original
    // metadata with provenance all round-trip unchanged.
    for (const { item, sources } of importInstagramExport(files, OPTIONS).items) {
      const aggregate = await repo.getArchiveItemAggregate(item.id);
      assert.deepEqual(aggregate?.item, item);
      assert.deepEqual(aggregate?.sources, sources);
    }
  });

  test("several sources of one post collapse onto one item", async () => {
    await ingestInstagramExport(repo, fixtureFiles(), OPTIONS);
    const reel = await repo.getArchiveItemAggregate(itemId("ReelAAA111"));
    assert.deepEqual(reel?.sources.map((s) => s.source), ["saved", "messages", "liked"]);
    const carousel = await repo.getArchiveItemAggregate(itemId("CarouBBB222"));
    assert.equal(carousel?.item.kind, "carousel");
    assert.equal(carousel?.sources.length, 3);
  });

  test("original metadata is stored with provenance pointing at a stored source", async () => {
    await ingestInstagramExport(repo, fixtureFiles(), OPTIONS);
    const reel = await repo.getArchiveItem(itemId("ReelAAA111"));
    assert.deepEqual(reel?.original.creator, {
      value: { username: "example_artist", displayName: "Zoë Example" },
      provenance: { from: "export", sourceRecordId: "owner-1:saved:fbid:18000000000000011" },
    });
    const row = db
      .prepare("SELECT provenance_source_record_id AS id FROM original_metadata WHERE archive_item_id = ? AND field = 'caption'")
      .get(itemId("ReelAAA111")) as { id: string };
    assert.equal(
      (db.prepare("SELECT archive_item_id FROM source_records WHERE id = ?").get(row.id) as { archive_item_id: string }).archive_item_id,
      itemId("ReelAAA111"),
    );
  });

  test("the summary is printable", async () => {
    const text = formatIngestionSummary(await ingestInstagramExport(repo, fixtureFiles(), OPTIONS));
    assert.match(text, /Source records seen: 9 \(new 9, already stored 0\)/);
    assert.match(text, /Unique items:        5 \(multi-source 2, in more than one of Messages\/Saved\/Liked 2\)/);
    assert.match(text, /1 × story link \(not a post or reel\)/);
  });
});

describe("idempotency", () => {
  test("re-importing the same export changes nothing", async () => {
    await ingestInstagramExport(repo, fixtureFiles(), OPTIONS);
    const before = snapshot();
    const summary = await ingestInstagramExport(repo, fixtureFiles(), LATER);

    assert.deepEqual(snapshot(), before);
    assert.equal(summary.newItems, 0);
    assert.equal(summary.updatedItems, 0);
    assert.equal(summary.unchangedItems, 5);
    assert.equal(summary.newSourceRecords, 0);
    assert.equal(summary.existingSourceRecords, 9);
  });

  test("a later export adds information to existing items without losing any", async () => {
    // Thread alone: carousel slide shares have no caption.
    await ingestInstagramExport(repo, only(THREAD), OPTIONS);
    const before = await repo.getArchiveItem(itemId("CarouBBB222"));
    assert.equal(before?.original.caption, undefined);

    // Liked adds the caption and full owner; the item is updated, not duplicated.
    const summary = await ingestInstagramExport(repo, only(LIKED), LATER);
    assert.equal(summary.updatedItems, 2); // ReelAAA111 and CarouBBB222
    const after = await repo.getArchiveItemAggregate(itemId("CarouBBB222"));
    assert.equal(after?.item.kind, "carousel");
    assert.equal(after?.item.original.caption?.value, "five poster studies, swipe for process");
    assert.equal(after?.sources.length, 3);
    assert.equal(after?.item.createdAt, OPTIONS.importedAt);

    // Re-importing just the thread again keeps what Liked contributed.
    const settled = snapshot();
    await ingestInstagramExport(repo, only(THREAD), LATER);
    assert.deepEqual(snapshot(), settled);
  });
});

describe("transactions", () => {
  test("a failure part-way rolls back the whole import", async () => {
    let saves = 0;
    const failing: ArchiveRepository = {
      ...bind(repo),
      withTransaction: (work) => repo.withTransaction(() => work(failing)),
      saveArchiveItem: async (item) => {
        if (++saves === 3) throw new Error("disk full");
        return repo.saveArchiveItem(item);
      },
    };
    await assert.rejects(ingestInstagramExport(failing, fixtureFiles(), OPTIONS), /disk full/);
    for (const table of ["archive_items", "source_records", "original_metadata"]) {
      assert.equal(rowCount(table), 0, table);
    }
    // The connection is usable afterwards and a clean retry succeeds.
    assert.equal((await ingestInstagramExport(repo, fixtureFiles(), OPTIONS)).newItems, 5);
  });

  test("an identity already held by a different item aborts without partial writes", async () => {
    await repo.saveArchiveItem({
      id: "legacy-id" as ArchiveItemId,
      ownerId: OWNER,
      identity: { kind: "shortcode", shortcode: "ReelAAA111" },
      kind: "reel",
      canonicalUrl: "https://www.instagram.com/reel/ReelAAA111/",
      createdAt: OPTIONS.importedAt,
      updatedAt: OPTIONS.importedAt,
    });
    await assert.rejects(ingestInstagramExport(repo, fixtureFiles(), OPTIONS), ArchiveIdentityConflictError);
    assert.equal(rowCount("archive_items"), 1);
    assert.equal(rowCount("source_records"), 0);
  });

  test("transactions cannot be nested", async () => {
    await assert.rejects(
      repo.withTransaction(() => repo.withTransaction(async () => undefined)),
      /cannot be nested/,
    );
  });
});

describe("readExportDirectory", () => {
  test("finds supported files from the export root or its activity folder", () => {
    const fromRoot = readExportDirectory(FIXTURES).files.map((f) => f.path);
    assert.deepEqual(fromRoot, [LIKED, THREAD, "your_instagram_activity/saved/saved_posts.json"]);
    const fromActivity = readExportDirectory(join(FIXTURES, "your_instagram_activity")).files.map((f) => f.path);
    assert.deepEqual(fromActivity, ["likes/liked_posts.json", "messages/inbox/friend_1234567890/message_1.json", "saved/saved_posts.json"]);
  });

  test("ignores unsupported files and reports unparsable ones", () => {
    const root = join(dir, "export");
    mkdirSync(join(root, "saved"), { recursive: true });
    mkdirSync(join(root, "likes"), { recursive: true });
    writeFileSync(join(root, "saved", "saved_collections.json"), "{}");
    writeFileSync(join(root, "likes", "liked_posts.json"), "{ not json");
    const result = readExportDirectory(root);
    assert.deepEqual(result.files, [] as ExportFile[]);
    assert.equal(result.unreadableFiles.length, 1);
    assert.equal(result.unreadableFiles[0]?.path, "likes/liked_posts.json");
  });
});

/** All repository methods bound to `target`, for decorating in tests. */
function bind(target: SqliteArchiveRepository): ArchiveRepository {
  return {
    withTransaction: (work) => target.withTransaction(work),
    saveArchiveItem: (i) => target.saveArchiveItem(i),
    addSourceRecords: (r) => target.addSourceRecords(r),
    saveOriginalMetadata: (id, m) => target.saveOriginalMetadata(id, m),
    saveMediaAssets: (a) => target.saveMediaAssets(a),
    appendAiOrganization: (s) => target.appendAiOrganization(s),
    saveCuratedOrganization: (c) => target.saveCuratedOrganization(c),
    getArchiveItem: (id) => target.getArchiveItem(id),
    getArchiveItemAggregate: (id) => target.getArchiveItemAggregate(id),
    findArchiveItemByIdentity: (o, i) => target.findArchiveItemByIdentity(o, i),
    listArchiveItems: (o, p) => target.listArchiveItems(o, p),
    enqueueMediaRetrieval: (r) => target.enqueueMediaRetrieval(r),
    saveMediaRetrievalRequest: (r) => target.saveMediaRetrievalRequest(r),
    getMediaRetrievalRequest: (id) => target.getMediaRetrievalRequest(id),
    listDueMediaRetrievals: (now, limit, options) => target.listDueMediaRetrievals(now, limit, options),
    countMediaRetrievalsByStatus: () => target.countMediaRetrievalsByStatus(),
    listAiEnrichmentCandidates: (o, opts) => target.listAiEnrichmentCandidates(o, opts),
    searchArchiveItems: (o, q, opts) => target.searchArchiveItems(o, q, opts),
  };
}
