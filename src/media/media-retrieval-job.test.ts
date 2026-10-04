import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, SourceRecordId, UserId } from "../domain/archive-item.ts";
import {
  newRetrievalRequest,
  recordRetrievalFailure,
  recordRetrievalSuccess,
  type RetrievalFailure,
} from "../domain/media-retrieval.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { MediaRetrievalJob, type MediaRetrievalJobItemRetriever } from "./media-retrieval-job.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const id = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;
// The fixture items in the main archive, newest first by their latest save/like/DM date.
// (The fixtures' fifth item, PostCCC333, is liked-only and never retrieved.)
const NEWEST_FIRST = ["ReelAAA111", "CarouBBB222", "ReplyEEE555", "BareDDD444"].map(id);

type Behaviour = "stored" | "unavailable" | "failed" | "rate_limited" | "throw";
const FAILURES: Record<Exclude<Behaviour, "stored" | "throw">, RetrievalFailure> = {
  unavailable: { kind: "unavailable", code: "deleted", message: "HTTP 404" },
  failed: { kind: "temporary", code: "server_error", message: "HTTP 500" },
  rate_limited: { kind: "temporary", code: "rate_limited", message: "HTTP 429" },
};

/** Applies a scripted outcome per item through the real request transitions. */
class ScriptedRetriever implements MediaRetrievalJobItemRetriever {
  calls: ArchiveItemId[] = [];
  behaviour = new Map<ArchiveItemId, Behaviour>();
  private readonly repo: SqliteArchiveRepository;
  private readonly now: () => string;
  constructor(repo: SqliteArchiveRepository, now: () => string) {
    this.repo = repo;
    this.now = now;
  }
  async retrieve(itemId: ArchiveItemId) {
    this.calls.push(itemId);
    const behaviour = this.behaviour.get(itemId) ?? "stored";
    if (behaviour === "throw") throw new Error("disk full");
    const request = (await this.repo.getMediaRetrievalRequest(itemId))!;
    const next = behaviour === "stored"
      ? recordRetrievalSuccess(request, this.now())
      : recordRetrievalFailure(request, FAILURES[behaviour], this.now());
    await this.repo.saveMediaRetrievalRequest(next);
    return { request: next, mediaType: "GraphImage" };
  }
}

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;
let clock: string;
let retriever: ScriptedRetriever;
let sleeps: number[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-job-"));
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
  clock = "2026-10-03T10:00:00.000Z";
  retriever = new ScriptedRetriever(repo, () => clock);
  sleeps = [];
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: clock });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const job = (delayMs = 0) =>
  new MediaRetrievalJob({ repository: repo, retriever, delayMs, now: () => clock, sleep: async (ms) => void sleeps.push(ms) });
const status = async (itemId: ArchiveItemId) => (await repo.getMediaRetrievalRequest(itemId))?.status;

describe("MediaRetrievalJob", () => {
  test("creates requests, then goes by priority and newest item first", async () => {
    await repo.enqueueMediaRetrieval(newRetrievalRequest(id("BareDDD444"), 100, clock)); // owner exchange
    const summary = await job().run({ ownerId: OWNER, limit: 10 });
    assert.equal(summary.enqueued, 3);
    assert.deepEqual(retriever.calls, [id("BareDDD444"), ...NEWEST_FIRST.filter((i) => i !== id("BareDDD444"))]);
    assert.equal(summary.stored, 4);
  });

  test("--limit caps the batch; the rest stays pending for later", async () => {
    const summary = await job().run({ ownerId: OWNER, limit: 2 });
    assert.deepEqual(retriever.calls, NEWEST_FIRST.slice(0, 2));
    assert.equal(summary.remainingDue, 2);
    for (const itemId of NEWEST_FIRST.slice(2)) assert.equal(await status(itemId), "pending");
  });

  test("--from-priority starts at a priority bucket", async () => {
    await repo.enqueueMediaRetrieval(newRetrievalRequest(id("BareDDD444"), 100, clock));
    await job().run({ ownerId: OWNER, limit: 10, maxPriority: 0 });
    assert.ok(!retriever.calls.includes(id("BareDDD444")));
    assert.equal(retriever.calls.length, 3);
  });

  test("already-stored items are skipped and never retrieved again", async () => {
    await repo.enqueueMediaRetrieval(recordRetrievalSuccess(newRetrievalRequest(id("CarouBBB222"), 0, clock), clock));
    const summary = await job().run({ ownerId: OWNER, limit: 10 });
    assert.ok(!retriever.calls.includes(id("CarouBBB222")));
    assert.equal(summary.alreadyStored, 1);
    assert.equal(summary.attempted, 3);
  });

  test("individual failures are recorded and the batch carries on", async () => {
    retriever.behaviour.set(id("ReelAAA111"), "failed");
    retriever.behaviour.set(id("CarouBBB222"), "unavailable");
    retriever.behaviour.set(id("ReplyEEE555"), "throw");
    const summary = await job(1500).run({ ownerId: OWNER, limit: 10 });

    assert.deepEqual(retriever.calls, NEWEST_FIRST);
    assert.deepEqual(
      [summary.attempted, summary.stored, summary.failed, summary.unavailable, summary.errors, summary.rateLimited],
      [4, 1, 1, 1, 1, false],
    );
    assert.deepEqual(summary.items.map((i) => i.outcome), ["failed", "unavailable", "error", "stored"]);
    assert.equal(await status(id("ReelAAA111")), "failed");
    assert.equal(await status(id("CarouBBB222")), "unavailable");
    assert.equal(await status(id("ReplyEEE555")), "pending"); // untouched; retried next run
    assert.equal(await status(id("BareDDD444")), "stored");
    assert.deepEqual(sleeps, [1500, 1500, 1500]); // paused between items only
  });

  test("a rate limit stops the whole batch and leaves the rest pending", async () => {
    retriever.behaviour.set(id("CarouBBB222"), "rate_limited");
    const summary = await job().run({ ownerId: OWNER, limit: 10 });

    assert.deepEqual(retriever.calls, NEWEST_FIRST.slice(0, 2));
    assert.equal(summary.rateLimited, true);
    assert.deepEqual(summary.items.map((i) => i.outcome), ["stored", "rate_limited"]);
    assert.equal(await status(id("ReelAAA111")), "stored"); // earlier work kept
    for (const itemId of NEWEST_FIRST.slice(2)) {
      const request = await repo.getMediaRetrievalRequest(itemId);
      assert.deepEqual([request?.status, request?.attempts], ["pending", 0]);
    }
    assert.equal(summary.remainingDue, 2);
  });

  test("running again resumes; failed items wait for their retry time", async () => {
    retriever.behaviour.set(id("ReelAAA111"), "failed");
    await job().run({ ownerId: OWNER, limit: 2 });
    assert.deepEqual(retriever.calls, NEWEST_FIRST.slice(0, 2));

    retriever.calls = [];
    retriever.behaviour.clear();
    const second = await job().run({ ownerId: OWNER, limit: 10 });
    assert.equal(second.enqueued, 0);
    assert.deepEqual(retriever.calls, NEWEST_FIRST.slice(2)); // ReelAAA111 not due yet
    assert.equal(second.alreadyStored, 1);

    clock = "2026-10-03T10:05:00.000Z"; // past its 1-minute backoff
    retriever.calls = [];
    const third = await job().run({ ownerId: OWNER, limit: 10 });
    assert.deepEqual(retriever.calls, [id("ReelAAA111")]);
    assert.equal(third.statusAfter.stored, 4);
  });
});

describe("main archive scope (Saved + Messages)", () => {
  // Fixtures: ReelAAA111 saved+messages+liked, CarouBBB222 liked+messages, ReplyEEE555 messages only,
  // BareDDD444 saved only, PostCCC333 liked only. LikedSaved6 (added here) is liked + saved.
  beforeEach(async () => {
    await repo.saveArchiveItem({
      id: id("LikedSaved6"), ownerId: OWNER, identity: { kind: "shortcode", shortcode: "LikedSaved6" }, kind: "post",
      canonicalUrl: "https://www.instagram.com/p/LikedSaved6/", createdAt: clock, updatedAt: clock,
    });
    await repo.addSourceRecords((["liked", "saved"] as const).map((source) => ({
      id: `LikedSaved6:${source}` as SourceRecordId, archiveItemId: id("LikedSaved6"), source,
      originalUrl: "https://www.instagram.com/p/LikedSaved6/", occurredAt: "2020-01-01T00:00:00.000Z",
      exportLocation: { file: `${source}.json` }, raw: {}, importedAt: clock,
    })));
  });

  test("saved, messages and liked + saved/messages items are retrieved; liked-only items are never selected or enqueued", async () => {
    const summary = await job().run({ ownerId: OWNER, limit: 100 });
    assert.deepEqual(retriever.calls, [...NEWEST_FIRST, id("LikedSaved6")]); // newest first, LikedSaved6 is oldest
    assert.ok(!retriever.calls.includes(id("PostCCC333")));
    assert.equal(summary.enqueued, 5);
    assert.equal(await repo.getMediaRetrievalRequest(id("PostCCC333")), undefined); // no request created
  });

  test("an existing liked-only request is left untouched and not counted, even when due", async () => {
    // From before the scope change: a pending request and a failed one past its retry time.
    await repo.enqueueMediaRetrieval(newRetrievalRequest(id("PostCCC333"), 100, "2026-10-01T00:00:00.000Z"));
    const failed = recordRetrievalFailure(
      newRetrievalRequest(id("PostCCC333"), 100, "2026-10-01T00:00:00.000Z"), FAILURES.failed, "2026-10-01T00:00:00.000Z",
    );
    await repo.saveMediaRetrievalRequest(failed); // highest priority and long due
    const before = await repo.getMediaRetrievalRequest(id("PostCCC333"));

    const summary = await job().run({ ownerId: OWNER, limit: 100 });
    assert.ok(!retriever.calls.includes(id("PostCCC333")));
    assert.deepEqual(await repo.getMediaRetrievalRequest(id("PostCCC333")), before);
    // Summary counts cover the main archive only: 5 items, all stored now, none due.
    assert.deepEqual(summary.statusBefore, { pending: 5, stored: 0, failed: 0, unavailable: 0 });
    assert.deepEqual(summary.statusAfter, { pending: 0, stored: 5, failed: 0, unavailable: 0 });
    assert.equal(summary.remainingDue, 0);
    // Unscoped, the liked-only request is still there and still due.
    assert.equal((await repo.countMediaRetrievalsByStatus()).failed, 1);
    assert.deepEqual((await repo.listDueMediaRetrievals(clock)).map((r) => r.archiveItemId), [id("PostCCC333")]);
  });
});
