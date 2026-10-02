import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItem, ArchiveItemId, MediaAssetId, UserId } from "../domain/archive-item.ts";
import { RETRIEVAL_PRIORITY, type RetrievalFailure } from "../domain/media-retrieval.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { LocalMediaStorage } from "./local-media-storage.ts";
import type { MediaSourceAdapter, RetrievalContext, RetrievalOutcome, RetrievedAsset } from "./media-source-adapter.ts";
import { fillMissingOriginalMetadata, MediaRetrievalService, ownerExchangePriority } from "./media-retrieval-service.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const T0 = "2026-10-01T10:00:00.000Z";
const id = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;

/** Synthetic bytes; nothing real is downloaded. */
const fakeBytes = (label: string) => new TextEncoder().encode(`fake-media:${label}`);
const image = (position: number, label = `img${position}`): RetrievedAsset => ({
  position, mediaType: "image", result: { ok: true, bytes: fakeBytes(label), mimeType: "image/jpeg", width: 1080, height: 1350 },
});
const failedAsset = (position: number, failure: RetrievalFailure): RetrievedAsset => ({
  position, mediaType: "image", result: { ok: false, failure },
});
const network: RetrievalFailure = { kind: "temporary", code: "network_error", message: "ECONNRESET" };
const deleted: RetrievalFailure = { kind: "unavailable", code: "deleted", message: "post removed" };

/** Adapter whose answers are scripted per item; records every call. */
class FakeAdapter implements MediaSourceAdapter {
  readonly name = "fake";
  calls: { itemId: ArchiveItemId; context: RetrievalContext }[] = [];
  answers = new Map<ArchiveItemId, (context: RetrievalContext) => RetrievalOutcome>();
  canRetrieve(): boolean {
    return true;
  }
  async retrieve(item: ArchiveItem, context: RetrievalContext): Promise<RetrievalOutcome> {
    this.calls.push({ itemId: item.id, context });
    const answer = this.answers.get(item.id);
    if (!answer) throw new Error(`no scripted answer for ${item.id}`);
    return answer(context);
  }
}

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;
let storage: LocalMediaStorage;
let adapter: FakeAdapter;
let clock: string;
let service: MediaRetrievalService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-retrieval-"));
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
  storage = new LocalMediaStorage(join(dir, "media"));
  adapter = new FakeAdapter();
  clock = T0;
  service = new MediaRetrievalService({ repository: repo, storage, adapters: [adapter], now: () => clock });
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: T0 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queue", () => {
  test("enqueue creates one pending request per item; enqueuing again is a no-op", async () => {
    assert.equal(await service.enqueue(id("CarouBBB222")), true);
    assert.equal(await service.enqueue(id("CarouBBB222")), false);
    assert.deepEqual(await repo.getMediaRetrievalRequest(id("CarouBBB222")), {
      archiveItemId: id("CarouBBB222"), priority: 0, status: "pending", attempts: 0, createdAt: T0, updatedAt: T0,
    });
  });

  test("due requests come highest priority first, then oldest", async () => {
    // Stand-in rule: anything the owner sent in a DM counts as an exchange.
    const priority = ownerExchangePriority((a) => a.sources.some((s) => s.message?.sentByOwner === true));
    assert.deepEqual(await service.enqueueAll(OWNER, priority), { created: 5, existing: 0 });
    assert.deepEqual(await service.enqueueAll(OWNER, priority), { created: 0, existing: 5 });

    const due = await repo.listDueMediaRetrievals(T0);
    assert.deepEqual(
      due.map((r) => [r.archiveItemId, r.priority]),
      [
        [id("ReelAAA111"), RETRIEVAL_PRIORITY.ownerExchange],
        [id("ReplyEEE555"), RETRIEVAL_PRIORITY.ownerExchange],
        [id("BareDDD444"), 0],
        [id("CarouBBB222"), 0],
        [id("PostCCC333"), 0],
      ],
    );
  });
});

describe("successful retrieval", () => {
  test("stores ordered carousel media outside SQLite and marks the request stored", async () => {
    await service.enqueue(id("CarouBBB222"));
    adapter.answers.set(id("CarouBBB222"), () => ({ ok: true, kind: "carousel", assets: [image(0), image(1), image(2)] }));

    const run = await service.process(id("CarouBBB222"));
    assert.equal(run.storedAssets, 3);
    assert.equal(run.request.status, "stored");
    assert.equal(run.request.attempts, 1);
    assert.equal(run.request.lastAttemptAt, T0);

    const aggregate = await repo.getArchiveItemAggregate(id("CarouBBB222"));
    assert.deepEqual(aggregate?.media.map((m) => m.role === "content" && m.position), [0, 1, 2]);
    for (const [i, asset] of (aggregate?.media ?? []).entries()) {
      assert.equal(asset.retrieval.status, "stored");
      if (asset.retrieval.status !== "stored") continue;
      // Bytes are on disk, unchanged; the database holds only the key.
      const file = join(dir, "media", asset.retrieval.storageKey);
      assert.ok(existsSync(file));
      assert.deepEqual(new Uint8Array(readFileSync(file)), fakeBytes(`img${i}`));
      assert.equal(asset.retrieval.width, 1080);
    }
    const blobs = db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE typeof(retrieval_json) = 'blob'").get() as { n: number };
    assert.equal(blobs.n, 0);
  });

  test("an already-stored request is not run again", async () => {
    await service.enqueue(id("CarouBBB222"));
    adapter.answers.set(id("CarouBBB222"), () => ({ ok: true, assets: [image(0)] }));
    await service.process(id("CarouBBB222"));
    assert.equal(await service.enqueue(id("CarouBBB222")), false);

    const again = await service.process(id("CarouBBB222"));
    assert.equal(again.alreadyStored, true);
    assert.equal(adapter.calls.length, 1);
    assert.equal(again.request.attempts, 1);
  });

  test("retrieved metadata only fills missing fields, with retrieval provenance", async () => {
    // BareDDD444 has no caption or creator in the export; PostCCC333 has both.
    for (const sc of ["BareDDD444", "PostCCC333"]) {
      await service.enqueue(id(sc));
      adapter.answers.set(id(sc), () => ({
        ok: true, kind: "carousel", assets: [image(0)],
        metadata: { caption: "caption seen today", creator: { username: "today_name" }, postedAt: "2026-01-01T00:00:00.000Z" },
      }));
      await service.process(id(sc));
    }
    const bare = await repo.getArchiveItem(id("BareDDD444"));
    assert.deepEqual(bare?.original.caption, { value: "caption seen today", provenance: { from: "retrieval", retrievedAt: T0 } });
    assert.equal(bare?.original.creator?.provenance.from, "retrieval");
    assert.equal(bare?.kind, "carousel"); // was unknown

    const post = await repo.getArchiveItem(id("PostCCC333"));
    assert.equal(post?.original.caption?.value, "type specimen, first draft"); // export kept
    assert.equal(post?.original.caption?.provenance.from, "export");
    assert.equal(post?.original.creator?.value.username, "typelab");
    assert.equal(post?.original.postedAt?.provenance.from, "retrieval"); // export never has it
  });

  test("a known kind is not overwritten by retrieval", async () => {
    await service.enqueue(id("ReelAAA111"));
    adapter.answers.set(id("ReelAAA111"), () => ({ ok: true, kind: "carousel", assets: [image(0)] }));
    await service.process(id("ReelAAA111"));
    assert.equal((await repo.getArchiveItem(id("ReelAAA111")))?.kind, "reel");
  });
});

describe("failures", () => {
  test("a temporary failure is retryable, scheduled, and leaves the item valid", async () => {
    const before = await repo.getArchiveItemAggregate(id("ReelAAA111"));
    await service.enqueue(id("ReelAAA111"));
    adapter.answers.set(id("ReelAAA111"), () => ({ ok: false, failure: network }));

    const run = await service.process(id("ReelAAA111"));
    assert.equal(run.request.status, "failed");
    assert.equal(run.request.attempts, 1);
    assert.equal(run.request.nextAttemptAt, "2026-10-01T10:01:00.000Z");
    assert.deepEqual(run.request.lastFailure, network);
    assert.deepEqual(await repo.listDueMediaRetrievals(T0), []);
    assert.equal((await repo.listDueMediaRetrievals("2026-10-01T10:01:00.000Z")).length, 1);

    // The ArchiveItem, its sources and metadata are untouched.
    assert.deepEqual(await repo.getArchiveItemAggregate(id("ReelAAA111")), before);
  });

  test("a thrown adapter error is recorded as a temporary failure", async () => {
    await service.enqueue(id("ReelAAA111"));
    adapter.answers.set(id("ReelAAA111"), () => {
      throw new Error("socket hang up");
    });
    const run = await service.process(id("ReelAAA111"));
    assert.equal(run.request.status, "failed");
    assert.deepEqual(run.request.lastFailure, { kind: "temporary", code: "unknown", message: "socket hang up" });
  });

  test("unavailable content is not retried automatically, but can be retried manually", async () => {
    await service.enqueue(id("PostCCC333"));
    adapter.answers.set(id("PostCCC333"), () => ({ ok: false, failure: deleted }));
    const run = await service.process(id("PostCCC333"));
    assert.equal(run.request.status, "unavailable");
    assert.equal(run.request.nextAttemptAt, undefined);
    assert.deepEqual(await repo.listDueMediaRetrievals("2030-01-01T00:00:00.000Z"), []);
    assert.ok(await repo.getArchiveItemAggregate(id("PostCCC333")));

    clock = "2026-10-02T00:00:00.000Z";
    await service.retryManually(id("PostCCC333"));
    adapter.answers.set(id("PostCCC333"), () => ({ ok: true, assets: [image(0)] }));
    const next = await service.processNext();
    assert.equal(next?.request.status, "stored");
    assert.equal(next?.request.attempts, 2);
  });

  test("a partly failed carousel keeps stored slides and only fetches the rest on retry", async () => {
    await service.enqueue(id("CarouBBB222"));
    adapter.answers.set(id("CarouBBB222"), () => ({
      ok: true, assets: [image(0), failedAsset(1, network), failedAsset(2, deleted)],
    }));
    const first = await service.process(id("CarouBBB222"));
    assert.equal(first.request.status, "failed"); // one slide can still be fetched
    let media = (await repo.getArchiveItemAggregate(id("CarouBBB222")))?.media ?? [];
    assert.deepEqual(media.map((m) => m.retrieval.status), ["stored", "failed", "unavailable"]);

    clock = first.request.nextAttemptAt ?? T0;
    adapter.answers.set(id("CarouBBB222"), (context) => ({
      ok: true,
      assets: [
        context.storedPositions.has(0) ? { position: 0, mediaType: "image", result: { ok: "already_stored" } } : image(0, "changed"),
        image(1),
        failedAsset(2, deleted),
      ],
    }));
    const second = await service.processNext();
    assert.deepEqual([...(adapter.calls[1]?.context.storedPositions ?? [])], [0]);
    assert.equal(second?.request.status, "stored");
    assert.equal(second?.request.attempts, 2);
    media = (await repo.getArchiveItemAggregate(id("CarouBBB222")))?.media ?? [];
    assert.deepEqual(media.map((m) => m.retrieval.status), ["stored", "stored", "unavailable"]);
  });

  test("an item whose media is all unavailable becomes unavailable", async () => {
    await service.enqueue(id("BareDDD444"));
    adapter.answers.set(id("BareDDD444"), () => ({ ok: true, assets: [failedAsset(0, deleted)] }));
    assert.equal((await service.process(id("BareDDD444"))).request.status, "unavailable");
  });
});

describe("derived frames", () => {
  test("are stored as derived_frame assets without touching the video", async () => {
    await service.enqueue(id("ReelAAA111"));
    adapter.answers.set(id("ReelAAA111"), () => ({
      ok: true,
      assets: [{ position: 0, mediaType: "video", result: { ok: true, bytes: fakeBytes("video"), mimeType: "video/mp4", durationMs: 15000 } }],
    }));
    await service.process(id("ReelAAA111"));
    const video = (await repo.getArchiveItemAggregate(id("ReelAAA111")))?.media[0];
    assert.ok(video);

    await service.storeDerivedFrames(id("ReelAAA111"), video.id, [0, 7500, 15000].map((ms) => ({
      frameTimeMs: ms, bytes: fakeBytes(`frame${ms}`), mimeType: "image/jpeg",
    })));
    const media = (await repo.getArchiveItemAggregate(id("ReelAAA111")))?.media ?? [];
    assert.deepEqual(media[0], video);
    assert.deepEqual(media.slice(1).map((m) => m.role === "derived_frame" && [m.derivedFromAssetId, m.frameTimeMs]), [
      [video.id, 0], [video.id, 7500], [video.id, 15000],
    ]);

    await assert.rejects(
      service.storeDerivedFrames(id("ReelAAA111"), "missing" as MediaAssetId, []),
      /is not a stored video/,
    );
  });
});

describe("re-import after retrieval", () => {
  const retrieval = { from: "retrieval", retrievedAt: T0 };

  test("values only retrieval supplied survive a re-import of the same export", async () => {
    // BareDDD444's export has no caption, creator or postedAt, and kind unknown.
    await service.enqueue(id("BareDDD444"));
    adapter.answers.set(id("BareDDD444"), () => ({
      ok: true, kind: "carousel", assets: [image(0)],
      metadata: { caption: "retrieved caption", creator: { username: "retrieved_user" }, postedAt: "2025-05-05T00:00:00.000Z" },
    }));
    await service.process(id("BareDDD444"));

    const summary = await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, {
      ownerId: OWNER, importedAt: "2026-10-05T00:00:00.000Z",
    });
    assert.equal(summary.updatedItems, 0);
    const item = await repo.getArchiveItem(id("BareDDD444"));
    assert.deepEqual(item?.original, {
      caption: { value: "retrieved caption", provenance: retrieval },
      creator: { value: { username: "retrieved_user" }, provenance: retrieval },
      postedAt: { value: "2025-05-05T00:00:00.000Z", provenance: retrieval },
    });
    // The export only knows "unknown", so the retrieved kind stays.
    assert.equal(item?.kind, "carousel");
  });

  test("an export value wins over a previously retrieved value", async () => {
    // ReplyEEE555's export has no caption or creator; retrieval fills them.
    await service.enqueue(id("ReplyEEE555"));
    adapter.answers.set(id("ReplyEEE555"), () => ({
      ok: true, assets: [image(0)],
      metadata: { caption: "retrieved caption", creator: { username: "retrieved_user" } },
    }));
    await service.process(id("ReplyEEE555"));
    assert.deepEqual((await repo.getArchiveItem(id("ReplyEEE555")))?.original.caption?.provenance, retrieval);

    // A later export (a Liked entry) supplies both.
    await ingestInstagramExport(repo, [likedExport("ReplyEEE555", "18000000000000099")], {
      ownerId: OWNER, importedAt: "2026-10-05T00:00:00.000Z",
    });
    const fromLiked = { from: "export", sourceRecordId: "owner-1:liked:fbid:18000000000000099" };
    const item = await repo.getArchiveItem(id("ReplyEEE555"));
    assert.deepEqual(item?.original.caption, { value: "export caption", provenance: fromLiked });
    assert.deepEqual(item?.original.creator, {
      value: { username: "export_user", displayName: "Export User" },
      provenance: fromLiked,
    });
  });
});

/** A Liked export entry in the real liked_posts.json shape. */
function likedExport(shortcode: string, fbid: string) {
  const url = `https://www.instagram.com/p/${shortcode}/`;
  return {
    path: "your_instagram_activity/likes/liked_posts.json",
    data: [{
      timestamp: 1791000000,
      media: [],
      label_values: [
        { label: "URL", value: url, href: url },
        { label: "Caption", value: "export caption" },
        { label: "Title", value: "" },
        { dict: [], title: "Hashtags" },
        { dict: [{ dict: [
          { label: "URL", value: "" },
          { label: "Name", value: "Export User" },
          { label: "Username", value: "export_user" },
        ], title: "" }], title: "Owner" },
        { dict: [], title: "Brand partner" },
      ],
      fbid,
    }],
  };
}

test("fillMissingOriginalMetadata returns the same object when nothing is missing", () => {
  const original = {
    caption: { value: "x", provenance: { from: "retrieval" as const, retrievedAt: T0 } },
    creator: { value: { username: "u" }, provenance: { from: "retrieval" as const, retrievedAt: T0 } },
    postedAt: { value: T0, provenance: { from: "retrieval" as const, retrievedAt: T0 } },
  };
  assert.equal(fillMissingOriginalMetadata(original, { caption: "y" }, T0), original);
  assert.equal(fillMissingOriginalMetadata({}, undefined, T0).caption, undefined);
});
