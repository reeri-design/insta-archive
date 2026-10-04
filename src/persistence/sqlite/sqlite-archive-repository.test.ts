import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, test } from "node:test";
import type {
  AiOrganization,
  AiOrganizationId,
  ArchiveItem,
  ArchiveItemId,
  CuratedOrganization,
  MediaAsset,
  MediaAssetId,
  SourceRecord,
  SourceRecordId,
  UserId,
} from "../../domain/archive-item.ts";
import { importInstagramExport } from "../../importers/instagram/import-export.ts";
import { isInMainArchive, MAIN_ARCHIVE_SOURCES } from "../../domain/archive-scope.ts";
import { ArchiveIdentityConflictError, PersistenceIntegrityError } from "../archive-repository.ts";
import { databasePathFromEnv, migrate, openDatabase } from "./database.ts";
import { MIGRATIONS } from "./migrations.ts";
import { SqliteArchiveRepository } from "./sqlite-archive-repository.ts";

const OWNER = "owner-1" as UserId;
const OTHER_OWNER = "owner-2" as UserId;
const T0 = "2026-10-01T09:00:00.000Z";

function makeItem(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: "owner-1:shortcode:ReelAAA111" as ArchiveItemId,
    ownerId: OWNER,
    identity: { kind: "shortcode", shortcode: "ReelAAA111" },
    kind: "reel",
    canonicalUrl: "https://www.instagram.com/reel/ReelAAA111/",
    original: {},
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeSource(
  id: string,
  archiveItemId: ArchiveItemId,
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    id: id as SourceRecordId,
    archiveItemId,
    source: "liked",
    originalUrl: "https://www.instagram.com/reel/ReelAAA111/",
    occurredAt: "2026-09-29T12:27:39.000Z",
    exportLocation: { file: "your_instagram_activity/likes/liked_posts.json", pointer: "/0" },
    raw: { fbid: id },
    importedAt: T0,
    ...overrides,
  };
}

function makeSuggestion(id: string, itemId: ArchiveItemId, createdAt: string): AiOrganization {
  return {
    id: id as AiOrganizationId,
    archiveItemId: itemId,
    fields: { type: "tutorial", category: "illustration", tags: ["sketchbook"], usefulFor: ["practice"] },
    confidence: 0.72,
    taxonomyVersion: "v0",
    provider: "test-provider",
    model: "test-model",
    promptVersion: "p1",
    createdAt,
  };
}

let db: DatabaseSync;
let repo: SqliteArchiveRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new SqliteArchiveRepository(db);
});

/** Item + one source, the minimum valid aggregate. */
async function seedItem(item = makeItem()): Promise<ArchiveItem> {
  await repo.saveArchiveItem(item);
  await repo.addSourceRecords([makeSource(`${item.id}:src:1`, item.id)]);
  return item;
}

describe("archive items", () => {
  test("1. create and retrieve one ArchiveItem, including original metadata", async () => {
    const item = makeItem();
    const source = makeSource("s1", item.id);
    await repo.saveArchiveItem(item);
    await repo.addSourceRecords([source]);
    const original: ArchiveItem["original"] = {
      creator: {
        value: { username: "example_artist", displayName: "Zoë Example" },
        provenance: { from: "export", sourceRecordId: source.id },
      },
      caption: {
        value: "it’s a sketchbook tour 🎨",
        provenance: { from: "retrieval", retrievedAt: "2026-10-01T10:00:00.000Z" },
      },
    };
    await repo.saveOriginalMetadata(item.id, original);

    assert.deepEqual(await repo.getArchiveItem(item.id), { ...item, original });
    assert.deepEqual(await repo.findArchiveItemByIdentity(OWNER, item.identity), { ...item, original });
    assert.equal(await repo.getArchiveItem("missing" as ArchiveItemId), undefined);
  });

  test("saving again updates kind/url/updatedAt but keeps createdAt", async () => {
    const item = await seedItem(makeItem({ kind: "unknown" }));
    await repo.saveArchiveItem({
      ...item,
      kind: "carousel",
      canonicalUrl: "https://www.instagram.com/p/ReelAAA111/",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const stored = await repo.getArchiveItem(item.id);
    assert.equal(stored?.kind, "carousel");
    assert.equal(stored?.createdAt, T0);
    assert.equal(stored?.updatedAt, "2026-10-02T00:00:00.000Z");
  });

  test("original metadata is replaced as a whole and must cite a source of the same item", async () => {
    const a = await seedItem();
    const b = await seedItem(
      makeItem({ id: "owner-1:shortcode:Other1" as ArchiveItemId, identity: { kind: "shortcode", shortcode: "Other1" } }),
    );
    await repo.saveOriginalMetadata(a.id, {
      caption: { value: "x", provenance: { from: "export", sourceRecordId: `${a.id}:src:1` as SourceRecordId } },
    });
    await repo.saveOriginalMetadata(a.id, {});
    assert.deepEqual((await repo.getArchiveItem(a.id))?.original, {});

    await assert.rejects(
      repo.saveOriginalMetadata(a.id, {
        caption: { value: "x", provenance: { from: "export", sourceRecordId: `${b.id}:src:1` as SourceRecordId } },
      }),
      /FOREIGN KEY constraint failed/,
    );
  });

  test("listArchiveItems is per owner, newest first, paginated", async () => {
    for (const [i, sc] of ["A1", "B2", "C3"].entries()) {
      await repo.saveArchiveItem(
        makeItem({
          id: `owner-1:shortcode:${sc}` as ArchiveItemId,
          identity: { kind: "shortcode", shortcode: sc },
          createdAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    await repo.saveArchiveItem(makeItem({ id: "owner-2:shortcode:A1" as ArchiveItemId, ownerId: OTHER_OWNER, identity: { kind: "shortcode", shortcode: "A1" } }));

    const ids = (items: ArchiveItem[]) => items.map((i) => i.id);
    assert.deepEqual(ids(await repo.listArchiveItems(OWNER)), [
      "owner-1:shortcode:C3",
      "owner-1:shortcode:B2",
      "owner-1:shortcode:A1",
    ]);
    assert.deepEqual(ids(await repo.listArchiveItems(OWNER, { limit: 1, offset: 1 })), ["owner-1:shortcode:B2"]);
  });

  test("listArchiveItems order 'recent' sorts by the latest save/like/DM date, undated items last", async () => {
    const item = (sc: string) => `owner-1:shortcode:${sc}` as ArchiveItemId;
    for (const sc of ["A1", "B2", "C3", "D4"]) {
      await repo.saveArchiveItem(makeItem({ id: item(sc), identity: { kind: "shortcode", shortcode: sc } }));
    }
    await repo.addSourceRecords([
      makeSource("a-old", item("A1"), { occurredAt: "2026-01-01T00:00:00.000Z" }),
      makeSource("a-new", item("A1"), { occurredAt: "2026-09-01T00:00:00.000Z", source: "saved" }), // latest wins
      makeSource("b", item("B2"), { occurredAt: "2026-05-01T00:00:00.000Z" }),
      makeSource("c", item("C3"), { occurredAt: "2026-12-01T00:00:00.000Z" }),
      makeSource("d", item("D4"), { occurredAt: undefined }),
    ]);

    const ids = (items: ArchiveItem[]) => items.map((i) => i.id);
    assert.deepEqual(ids(await repo.listArchiveItems(OWNER, { order: "recent" })), [item("C3"), item("A1"), item("B2"), item("D4")]);
    assert.deepEqual(ids(await repo.listArchiveItems(OWNER, { order: "recent", limit: 2, offset: 1 })), [item("A1"), item("B2")]);
  });

  describe("main archive scope (Saved + Messages)", () => {
    // One item per combination of source kinds.
    const COMBOS: Record<string, SourceRecord["source"][]> = {
      likedOnly: ["liked"],
      savedOnly: ["saved"],
      messagesOnly: ["messages"],
      likedSaved: ["liked", "saved"],
      likedMessages: ["liked", "messages"],
      likedSavedMessages: ["liked", "saved", "messages"],
    };
    const item = (name: string) => `owner-1:shortcode:${name}` as ArchiveItemId;
    const IN_SCOPE = ["savedOnly", "messagesOnly", "likedSaved", "likedMessages", "likedSavedMessages"].map(item).sort();

    beforeEach(async () => {
      for (const [name, kinds] of Object.entries(COMBOS)) {
        await repo.saveArchiveItem(makeItem({ id: item(name), identity: { kind: "shortcode", shortcode: name } }));
        await repo.addSourceRecords(kinds.map((source) => makeSource(`${name}:${source}`, item(name), { source })));
      }
    });
    const sorted = (ids: string[]) => [...ids].sort();

    test("listArchiveItems with MAIN_ARCHIVE_SOURCES keeps any item with a saved or messages source, drops liked-only", async () => {
      const listed = await repo.listArchiveItems(OWNER, { sources: MAIN_ARCHIVE_SOURCES });
      assert.deepEqual(sorted(listed.map((i) => i.id)), IN_SCOPE);
      assert.equal((await repo.listArchiveItems(OWNER, { sources: MAIN_ARCHIVE_SOURCES, order: "recent" })).length, 5);
      // Without a filter every item is still listed, and liked records stay attached and stored.
      assert.equal((await repo.listArchiveItems(OWNER)).length, 6);
      assert.deepEqual((await repo.getArchiveItemAggregate(item("likedSaved")))?.sources.map((s) => s.source).sort(), ["liked", "saved"]);
      assert.ok(await repo.getArchiveItemAggregate(item("likedOnly")));
    });

    test("AI enrichment candidates with MAIN_ARCHIVE_SOURCES exclude liked-only items", async () => {
      const candidates = await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES });
      assert.deepEqual(sorted(candidates.map((c) => c.itemId)), IN_SCOPE);
      assert.equal((await repo.listAiEnrichmentCandidates(OWNER)).length, 6); // unfiltered
    });

    test("the domain rule agrees with the query, and unknown source kinds are refused", async () => {
      for (const [name, kinds] of Object.entries(COMBOS)) {
        assert.equal(isInMainArchive(kinds.map((source) => ({ source }))), IN_SCOPE.includes(item(name)), name);
      }
      await assert.rejects(repo.listArchiveItems(OWNER, { sources: ["saved'); DROP TABLE x; --" as SourceRecord["source"]] }), /Unknown source kind/);
      assert.deepEqual(await repo.listArchiveItems(OWNER, { sources: [] }), []);
    });
  });
});

describe("identity", () => {
  test("3. the same identity cannot create a second item for the same owner", async () => {
    await seedItem();
    await assert.rejects(
      repo.saveArchiveItem(makeItem({ id: "owner-1:another-id" as ArchiveItemId })),
      ArchiveIdentityConflictError,
    );
    const count = db.prepare("SELECT COUNT(*) AS n FROM archive_items").get() as { n: number };
    assert.equal(count.n, 1);
  });

  test("an existing item id cannot be re-pointed at another identity", async () => {
    const item = await seedItem();
    await assert.rejects(
      repo.saveArchiveItem({ ...item, identity: { kind: "shortcode", shortcode: "Changed1" } }),
      ArchiveIdentityConflictError,
    );
  });

  test("4. different owners can hold the same Instagram identity", async () => {
    await seedItem();
    const theirs = makeItem({ id: "owner-2:shortcode:ReelAAA111" as ArchiveItemId, ownerId: OTHER_OWNER });
    await repo.saveArchiveItem(theirs);
    assert.equal((await repo.findArchiveItemByIdentity(OTHER_OWNER, theirs.identity))?.id, theirs.id);
    assert.equal(
      (await repo.findArchiveItemByIdentity(OWNER, theirs.identity))?.id,
      "owner-1:shortcode:ReelAAA111",
    );
  });

  test("url identities are stored and found too", async () => {
    const item = makeItem({
      id: "owner-1:url:x" as ArchiveItemId,
      identity: { kind: "url", normalizedUrl: "https://www.instagram.com/x/" },
    });
    await repo.saveArchiveItem(item);
    assert.deepEqual(await repo.findArchiveItemByIdentity(OWNER, item.identity), item);
  });
});

describe("source records", () => {
  test("2. several SourceRecords attach to one ArchiveItem, ordered by occurredAt", async () => {
    const item = makeItem();
    await repo.saveArchiveItem(item);
    const saved = makeSource("s-saved", item.id, { source: "saved", occurredAt: "2026-09-17T05:07:40.000Z" });
    const liked = makeSource("s-liked", item.id);
    const noTime = makeSource("s-none", item.id, { source: "saved" });
    delete noTime.occurredAt;
    const message = makeSource("s-msg", item.id, {
      source: "messages",
      occurredAt: "2026-09-28T14:39:57.945Z",
      originalUrl: "https://www.instagram.com/reel/ReelAAA111/?id=1_2",
      message: { threadId: "inbox/t_1", senderName: "Friend", sentByOwner: false },
    });
    assert.deepEqual(await repo.addSourceRecords([liked, message, saved, noTime]), { inserted: 4, existing: 0 });

    const aggregate = await repo.getArchiveItemAggregate(item.id);
    assert.deepEqual(aggregate?.sources, [saved, message, liked, noTime]);
  });

  test("re-adding the same records is a no-op; they are never rewritten", async () => {
    const item = makeItem();
    await repo.saveArchiveItem(item);
    const source = makeSource("s1", item.id, { sharedText: "first" });
    await repo.addSourceRecords([source]);
    assert.deepEqual(
      await repo.addSourceRecords([{ ...source, sharedText: "changed" }]),
      { inserted: 0, existing: 1 },
    );
    assert.equal((await repo.getArchiveItemAggregate(item.id))?.sources[0].sharedText, "first");
  });

  test("a source id already attached to another item is rejected", async () => {
    const a = await seedItem();
    const b = makeItem({ id: "owner-1:shortcode:B1" as ArchiveItemId, identity: { kind: "shortcode", shortcode: "B1" } });
    await repo.saveArchiveItem(b);
    await assert.rejects(repo.addSourceRecords([makeSource(`${a.id}:src:1`, b.id)]), PersistenceIntegrityError);
  });

  test("a source for a missing item is rejected", async () => {
    await assert.rejects(
      repo.addSourceRecords([makeSource("s1", "nope" as ArchiveItemId)]),
      /FOREIGN KEY constraint failed/,
    );
  });

  test("9. raw export JSON and message context survive a write/read round trip", async () => {
    const fixtures = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
    const threadPath = "your_instagram_activity/messages/inbox/friend_1234567890/message_1.json";
    const result = importInstagramExport(
      [{ path: threadPath, data: JSON.parse(readFileSync(join(fixtures, threadPath), "utf8")) }],
      { ownerId: OWNER, importedAt: T0, exportId: "export-1" },
    );
    for (const { item, sources } of result.items) {
      await repo.saveArchiveItem(item);
      await repo.addSourceRecords(sources);
      await repo.saveOriginalMetadata(item.id, item.original);
    }
    for (const { item, sources } of result.items) {
      const aggregate = await repo.getArchiveItemAggregate(item.id);
      assert.deepEqual(aggregate?.item, item);
      assert.deepEqual(aggregate?.sources, sources);
    }
    // Raw is the export's fragment as-is: still mojibake, not the decoded text.
    const reel = await repo.findArchiveItemByIdentity(OWNER, { kind: "shortcode", shortcode: "ReelAAA111" });
    assert.ok(reel);
    const [stored] = (await repo.getArchiveItemAggregate(reel.id))?.sources ?? [];
    assert.equal((stored?.raw as { sender_name: string }).sender_name, "Owner\u00e2\u0080\u0099s Studio");
    assert.equal(stored?.message?.senderName, "Owner’s Studio");
  });
});

describe("media assets", () => {
  test("5. an item can exist with no media assets", async () => {
    const item = await seedItem();
    assert.deepEqual((await repo.getArchiveItemAggregate(item.id))?.media, []);
  });

  test("6. pending, stored, failed and unavailable retrieval states persist; frames follow content", async () => {
    const item = await seedItem();
    const asset = (id: string) => id as MediaAssetId;
    const assets: MediaAsset[] = [
      {
        id: asset("frame-2"), archiveItemId: item.id, mediaType: "image", role: "derived_frame",
        derivedFromAssetId: asset("video"), frameTimeMs: 2000, retrieval: { status: "pending" },
      },
      {
        id: asset("video"), archiveItemId: item.id, mediaType: "video", role: "content", position: 0,
        retrieval: { status: "failed", lastAttemptAt: T0, attempts: 3, error: "HTTP 429" },
      },
      {
        id: asset("slide-1"), archiveItemId: item.id, mediaType: "image", role: "content", position: 1,
        retrieval: { status: "unavailable", checkedAt: T0, reason: "deleted", detail: "404" },
      },
      {
        id: asset("slide-2"), archiveItemId: item.id, mediaType: "image", role: "content", position: 2,
        retrieval: { status: "stored", storageKey: "media/ab/cd.jpg", mimeType: "image/jpeg", retrievedAt: T0, width: 1080, height: 1350 },
      },
    ];
    await repo.saveMediaAssets(assets);
    const media = (await repo.getArchiveItemAggregate(item.id))?.media;
    assert.deepEqual(media, [assets[1], assets[2], assets[3], assets[0]]);

    // A later retrieval attempt updates the state in place.
    const retried: MediaAsset = { ...assets[1]!, retrieval: { status: "stored", storageKey: "v.mp4", mimeType: "video/mp4", retrievedAt: T0, durationMs: 15000 } };
    await repo.saveMediaAssets([retried]);
    assert.deepEqual((await repo.getArchiveItemAggregate(item.id))?.media[0], retried);
  });

  test("content positions are unique per item, and role-specific columns are enforced", async () => {
    const item = await seedItem();
    const content = (id: string, position: number): MediaAsset => ({
      id: id as MediaAssetId, archiveItemId: item.id, mediaType: "image", role: "content", position, retrieval: { status: "pending" },
    });
    await repo.saveMediaAssets([content("a", 0)]);
    await assert.rejects(repo.saveMediaAssets([content("b", 0)]), /UNIQUE constraint failed/);
    assert.throws(
      () => db.prepare(
        `INSERT INTO media_assets (id, archive_item_id, role, media_type, retrieval_status, retrieval_json)
         VALUES ('c', ?, 'content', 'image', 'pending', '{"status":"pending"}')`,
      ).run(item.id),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(
        `INSERT INTO media_assets (id, archive_item_id, role, media_type, position, retrieval_status, retrieval_json)
         VALUES ('d', ?, 'content', 'image', 5, 'stored', '{"status":"pending"}')`,
      ).run(item.id),
      /CHECK constraint failed/,
    );
  });
});

describe("derived frames", () => {
  const frame = (itemId: ArchiveItemId, ms: number, derivedFromAssetId?: string): MediaAsset => ({
    id: `${itemId}:frame:${ms}` as MediaAssetId,
    archiveItemId: itemId,
    mediaType: "image",
    role: "derived_frame",
    ...(derivedFromAssetId && { derivedFromAssetId: derivedFromAssetId as MediaAssetId }),
    frameTimeMs: ms,
    retrieval: { status: "stored", storageKey: `frames/${ms}.jpg`, mimeType: "image/jpeg", retrievedAt: T0 },
  });

  test("can exist without derivedFromAssetId, keep their timestamps and come back in time order", async () => {
    const item = await seedItem();
    const frames = [frame(item.id, 4000), frame(item.id, 0), frame(item.id, 2000)];
    await repo.saveMediaAssets(frames);
    const media = (await repo.getArchiveItemAggregate(item.id))?.media;
    assert.deepEqual(media, [frames[1], frames[2], frames[0]]);
    assert.ok(media?.every((m) => !("derivedFromAssetId" in m)));
  });

  test("with derivedFromAssetId still behave as before", async () => {
    const item = await seedItem();
    const video: MediaAsset = {
      id: "video" as MediaAssetId, archiveItemId: item.id, mediaType: "video", role: "content", position: 0,
      retrieval: { status: "stored", storageKey: "v.mp4", mimeType: "video/mp4", retrievedAt: T0 },
    };
    const linked = frame(item.id, 1500, "video");
    await repo.saveMediaAssets([linked, video]);
    assert.deepEqual((await repo.getArchiveItemAggregate(item.id))?.media, [video, linked]);

    // The link is still checked: it must name an existing video of the same item.
    await assert.rejects(repo.saveMediaAssets([frame(item.id, 9, "missing-video")]), /FOREIGN KEY constraint failed/);
    // Frames still need a timestamp and still cannot take a position.
    for (const sql of [
      "INSERT INTO media_assets (id, archive_item_id, role, media_type, retrieval_status, retrieval_json) VALUES ('f1', ?, 'derived_frame', 'image', 'pending', '{\"status\":\"pending\"}')",
      "INSERT INTO media_assets (id, archive_item_id, role, media_type, position, frame_time_ms, retrieval_status, retrieval_json) VALUES ('f2', ?, 'derived_frame', 'image', 0, 0, 'pending', '{\"status\":\"pending\"}')",
    ]) {
      assert.throws(() => db.prepare(sql).run(item.id), /CHECK constraint failed/);
    }
  });
});

describe("AI organization", () => {
  test("7. several suggestions per item, append-only and immutable", async () => {
    const item = await seedItem();
    const first = makeSuggestion("ai-1", item.id, "2026-10-01T10:00:00.000Z");
    const second = { ...makeSuggestion("ai-2", item.id, "2026-10-02T10:00:00.000Z"), confidence: 0.9 };
    await repo.appendAiOrganization(second);
    await repo.appendAiOrganization(first);

    assert.deepEqual((await repo.getArchiveItemAggregate(item.id))?.aiSuggestions, [first, second]);
    await assert.rejects(repo.appendAiOrganization(first), PersistenceIntegrityError);
    assert.throws(
      () => db.prepare("UPDATE ai_organizations SET confidence = 0.1 WHERE id = 'ai-1'").run(),
      /immutable/,
    );
  });

  test("AI output is stored apart from original metadata", async () => {
    const item = await seedItem();
    await repo.appendAiOrganization(makeSuggestion("ai-1", item.id, T0));
    assert.deepEqual((await repo.getArchiveItem(item.id))?.original, {});
  });
});

describe("curated organization", () => {
  test("8. at most one per item: saving again replaces it", async () => {
    const item = await seedItem();
    await repo.appendAiOrganization(makeSuggestion("ai-1", item.id, T0));
    const curated: CuratedOrganization = {
      archiveItemId: item.id,
      fields: { type: "tutorial", tags: ["sketchbook"], usefulFor: [] },
      fieldOrigins: { type: "ai_accepted", tags: "human_edited" },
      basedOnSuggestionId: "ai-1" as AiOrganizationId,
      taxonomyVersion: "v0",
      reviewedBy: OWNER,
      reviewedAt: T0,
    };
    await repo.saveCuratedOrganization(curated);
    const edited: CuratedOrganization = {
      ...curated,
      fields: { ...curated.fields, category: "illustration" },
      fieldOrigins: { ...curated.fieldOrigins, category: "human_added" },
      reviewedAt: "2026-10-02T00:00:00.000Z",
    };
    await repo.saveCuratedOrganization(edited);

    const count = db.prepare("SELECT COUNT(*) AS n FROM curated_organizations").get() as { n: number };
    assert.equal(count.n, 1);
    assert.deepEqual((await repo.getArchiveItemAggregate(item.id))?.curated, edited);
  });

  test("basedOnSuggestionId must be a suggestion of the same item", async () => {
    const a = await seedItem();
    const b = await seedItem(makeItem({ id: "owner-1:shortcode:B1" as ArchiveItemId, identity: { kind: "shortcode", shortcode: "B1" } }));
    await repo.appendAiOrganization(makeSuggestion("ai-b", b.id, T0));
    await assert.rejects(
      repo.saveCuratedOrganization({
        archiveItemId: a.id,
        fields: { tags: [], usefulFor: [] },
        fieldOrigins: {},
        basedOnSuggestionId: "ai-b" as AiOrganizationId,
        taxonomyVersion: "v0",
        reviewedBy: OWNER,
        reviewedAt: T0,
      }),
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("aggregate", () => {
  test("10. loads the item with sources, media, AI suggestions and curation", async () => {
    const item = makeItem({ kind: "carousel" });
    const sources = [makeSource("s1", item.id), makeSource("s2", item.id, { source: "saved", occurredAt: "2026-09-01T00:00:00.000Z" })];
    const original: ArchiveItem["original"] = {
      caption: { value: "caption", provenance: { from: "export", sourceRecordId: "s2" as SourceRecordId } },
    };
    const media: MediaAsset[] = [
      { id: "m0" as MediaAssetId, archiveItemId: item.id, mediaType: "image", role: "content", position: 0, retrieval: { status: "pending" } },
    ];
    const suggestion = makeSuggestion("ai-1", item.id, T0);
    const curated: CuratedOrganization = {
      archiveItemId: item.id,
      fields: { tags: ["x"], usefulFor: [] },
      fieldOrigins: { tags: "human_added" },
      taxonomyVersion: "v0",
      reviewedBy: OWNER,
      reviewedAt: T0,
    };

    await repo.saveArchiveItem(item);
    await repo.addSourceRecords(sources);
    await repo.saveOriginalMetadata(item.id, original);
    await repo.saveMediaAssets(media);
    await repo.appendAiOrganization(suggestion);
    await repo.saveCuratedOrganization(curated);

    assert.deepEqual(await repo.getArchiveItemAggregate(item.id), {
      item: { ...item, original },
      sources: [sources[1], sources[0]],
      media,
      aiSuggestions: [suggestion],
      curated,
    });
  });

  test("an item without source records is reported, not returned as a valid aggregate", async () => {
    const item = makeItem();
    await repo.saveArchiveItem(item);
    await assert.rejects(repo.getArchiveItemAggregate(item.id), PersistenceIntegrityError);
    assert.equal(await repo.getArchiveItemAggregate("missing" as ArchiveItemId), undefined);
  });
});

describe("database", () => {
  test("migrations run once on a file database and are recorded in user_version", () => {
    const dir = mkdtempSync(join(tmpdir(), "insta-archive-test-"));
    try {
      const path = join(dir, "nested", "test.sqlite");
      openDatabase(path).close();
      const reopened = openDatabase(path);
      const { user_version } = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(user_version, MIGRATIONS.length);
      const fk = reopened.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      assert.equal(fk.foreign_keys, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration 4 keeps existing media and allows one cover image per item", () => {
    // A database at version 3 with a video, a linked frame and a frames-only frame.
    const v3 = new DatabaseSync(":memory:");
    v3.exec("PRAGMA foreign_keys = ON");
    for (const sql of MIGRATIONS.slice(0, 3)) v3.exec(sql);
    v3.exec("PRAGMA user_version = 3");
    v3.exec(`INSERT INTO archive_items VALUES ('i1', 'o1', 'shortcode', 'R1', 'reel', 'u', '${T0}', '${T0}')`);
    v3.exec(`INSERT INTO archive_items VALUES ('i2', 'o1', 'shortcode', 'R2', 'reel', 'u', '${T0}', '${T0}')`);
    const stored = (key: string) => JSON.stringify({ status: "stored", storageKey: key, mimeType: "x", retrievedAt: T0 });
    v3.prepare("INSERT INTO media_assets VALUES ('v', 'i1', 'content', 'video', 0, NULL, NULL, 'stored', ?)").run(stored("v.mp4"));
    v3.prepare("INSERT INTO media_assets VALUES ('f', 'i1', 'derived_frame', 'image', NULL, 'v', 500, 'stored', ?)").run(stored("f.jpg"));
    v3.prepare("INSERT INTO media_assets VALUES ('g', 'i2', 'derived_frame', 'image', NULL, NULL, 0, 'stored', ?)").run(stored("g.jpg"));
    assert.throws(
      () => v3.prepare("INSERT INTO media_assets VALUES ('c', 'i1', 'cover', 'image', NULL, NULL, NULL, 'stored', ?)").run(stored("c.jpg")),
      /CHECK constraint failed/,
    );
    const before = v3.prepare("SELECT * FROM media_assets ORDER BY id").all();

    migrate(v3);
    assert.equal((v3.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.deepEqual(v3.prepare("SELECT * FROM media_assets ORDER BY id").all(), before);
    assert.deepEqual(v3.prepare("PRAGMA foreign_key_check").all(), []);

    const insert = (id: string, item: string, type: string, position: number | null, frame: number | null) =>
      v3.prepare("INSERT INTO media_assets VALUES (?, ?, 'cover', ?, ?, NULL, ?, 'stored', ?)").run(id, item, type, position, frame, stored(`${id}.jpg`));
    insert("c1", "i1", "image", null, null);
    insert("c2", "i2", "image", null, null); // one per item, for any item
    assert.throws(() => insert("c3", "i1", "image", null, null), /UNIQUE constraint failed/);
    assert.throws(() => insert("c4", "i2", "video", null, null), /CHECK constraint failed/); // always an image
    assert.throws(() => insert("c5", "i2", "image", 0, null), /CHECK constraint failed/); // no position
    assert.throws(() => insert("c6", "i2", "image", null, 0), /CHECK constraint failed/); // no frame time
    // Existing rules still hold.
    assert.throws(
      () => v3.prepare("INSERT INTO media_assets VALUES ('x', 'i1', 'content', 'image', 0, NULL, NULL, 'stored', ?)").run(stored("x.jpg")),
      /UNIQUE constraint failed/,
    );
    v3.close();
  });

  test("a cover image asset round-trips through the repository", async () => {
    const itemId = "owner-1:shortcode:ReelAAA111" as ArchiveItemId;
    await repo.saveArchiveItem(makeItem());
    await repo.addSourceRecords([makeSource("cover-src", itemId)]);
    const cover: MediaAsset = {
      id: `${itemId}:cover` as MediaAssetId, archiveItemId: itemId, mediaType: "image", role: "cover",
      retrieval: { status: "stored", storageKey: "k/cover.jpg", mimeType: "image/jpeg", retrievedAt: T0, width: 640, height: 1136 },
    };
    const withheld: MediaAsset = {
      id: `${itemId}:media:0` as MediaAssetId, archiveItemId: itemId, mediaType: "video", role: "content", position: 0,
      retrieval: { status: "unavailable", checkedAt: T0, reason: "restricted", detail: "Embed page has no video URL" },
    };
    await repo.saveMediaAssets([cover, withheld]);
    const media = (await repo.getArchiveItemAggregate(itemId))?.media ?? [];
    assert.deepEqual([...media].sort((a, b) => a.id.localeCompare(b.id)), [cover, withheld]);
  });

  test("migration 3 keeps existing media and lets frames exist without a video", () => {
    // A database at version 2 (before the change) with a video and a linked frame.
    const v2 = new DatabaseSync(":memory:");
    v2.exec("PRAGMA foreign_keys = ON");
    for (const sql of MIGRATIONS.slice(0, 2)) v2.exec(sql);
    v2.exec("PRAGMA user_version = 2");
    v2.exec(`INSERT INTO archive_items VALUES ('i1', 'o1', 'shortcode', 'R1', 'reel', 'u', '${T0}', '${T0}')`);
    const stored = (key: string) => JSON.stringify({ status: "stored", storageKey: key, mimeType: "x", retrievedAt: T0 });
    v2.prepare("INSERT INTO media_assets VALUES ('v', 'i1', 'content', 'video', 0, NULL, NULL, 'stored', ?)").run(stored("v.mp4"));
    v2.prepare("INSERT INTO media_assets VALUES ('f', 'i1', 'derived_frame', 'image', NULL, 'v', 500, 'stored', ?)").run(stored("f.jpg"));
    assert.throws(
      () => v2.prepare("INSERT INTO media_assets VALUES ('g', 'i1', 'derived_frame', 'image', NULL, NULL, 0, 'stored', ?)").run(stored("g.jpg")),
      /CHECK constraint failed/,
    );
    const before = v2.prepare("SELECT * FROM media_assets ORDER BY id").all();

    migrate(v2);
    assert.equal((v2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.deepEqual(v2.prepare("SELECT * FROM media_assets ORDER BY id").all(), before);
    assert.deepEqual(v2.prepare("PRAGMA foreign_key_check").all(), []);

    v2.prepare("INSERT INTO media_assets VALUES ('g', 'i1', 'derived_frame', 'image', NULL, NULL, 0, 'stored', ?)").run(stored("g.jpg"));
    assert.throws(
      () => v2.prepare("INSERT INTO media_assets VALUES ('h', 'i1', 'derived_frame', 'image', NULL, 'missing', 0, 'stored', ?)").run(stored("h.jpg")),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => v2.prepare("INSERT INTO media_assets VALUES ('c', 'i1', 'content', 'image', 0, NULL, NULL, 'stored', ?)").run(stored("c.jpg")),
      /UNIQUE constraint failed/, // content positions still unique per item
    );
    v2.close();
  });

  test("DATABASE_PATH is required and resolved", () => {
    assert.throws(() => databasePathFromEnv({}), /DATABASE_PATH is not set/);
    assert.equal(databasePathFromEnv({ DATABASE_PATH: "/tmp/x.sqlite" }), "/tmp/x.sqlite");
  });
});
