import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, UserId } from "../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { aiEnrichmentLeaseMsFromEnv, DEFAULT_AI_ENRICHMENT_LEASE_MS, runEnrichmentBatch, selectItemsForEnrichment } from "./enrichment-batch.ts";
import { isEnrichmentCandidate } from "./enrichment-eligibility.ts";
import { AiEnrichmentService } from "./enrichment-service.ts";
import { AiProviderError, type OrganizationProvider, type OrganizationRequest, type OrganizationResponse } from "./organization-provider.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const T0 = "2026-10-03T12:00:00.000Z";
const GOOD = {
  type: "inspiration", category: "craft", tags: ["embroidery", "sketchbook", "floral motifs"],
  summary: "An embroidered sketchbook page.", usefulFor: ["stitch reference"], confidence: 0.8,
};
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

/** Answers after a short wait, so concurrent workers interleave; can be told to fail. */
class SlowProvider implements OrganizationProvider {
  readonly provider = "fake-ai";
  readonly model = "fake-model-1";
  calls: string[] = [];
  fail = false;
  async organize(request: OrganizationRequest): Promise<OrganizationResponse> {
    this.calls.push(request.content);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.fail) throw new AiProviderError("provider_error", "upstream 502");
    return { output: GOOD, model: this.model };
  }
}

let dir: string;
let path: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-claims-"));
  path = join(dir, "test.sqlite");
  db = openDatabase(path);
  repo = new SqliteArchiveRepository(db);
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: T0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Another worker: its own connection to the same database file, as a separate process would have. */
const otherWorker = () => {
  const connection = openDatabase(path);
  return { repo: new SqliteArchiveRepository(connection), close: () => connection.close() };
};
const candidates = async () => (await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES })).filter(isEnrichmentCandidate);
// Rows as plain objects (node:sqlite returns null-prototype ones).
const claimsTable = () => db.prepare("SELECT archive_item_id, worker_id FROM ai_enrichment_claims ORDER BY 1").all().map((r) => ({ ...r }));
const organizations = () =>
  (db.prepare("SELECT archive_item_id, COUNT(*) AS n FROM ai_organizations GROUP BY 1 ORDER BY 1").all() as { archive_item_id: string; n: number }[]).map((r) => ({ ...r }));
const lease = (workerId: string, nowMs = 0, leaseMs = 60_000) => ({ workerId, now: at(nowMs), expiresAt: at(nowMs + leaseMs) });

describe("claiming items for AI enrichment", () => {
  test("two workers claiming the same item at once: exactly one succeeds", async () => {
    const [item] = await candidates();
    assert.ok(item);
    const b = otherWorker();
    try {
      const results = await Promise.all([repo.claimAiEnrichment(item.itemId, lease("worker-a")), b.repo.claimAiEnrichment(item.itemId, lease("worker-b"))]);
      assert.deepEqual(results.filter(Boolean).length, 1);
      assert.equal(claimsTable().length, 1);
    } finally {
      b.close();
    }
  });

  test("different items can be claimed at the same time", async () => {
    const [first, second] = await candidates();
    assert.ok(first && second);
    const b = otherWorker();
    try {
      assert.deepEqual(
        await Promise.all([repo.claimAiEnrichment(first.itemId, lease("worker-a")), b.repo.claimAiEnrichment(second.itemId, lease("worker-b"))]),
        [true, true],
      );
    } finally {
      b.close();
    }
  });

  test("an active claim cannot be taken over; the holder may renew it", async () => {
    const [item] = await candidates();
    assert.ok(await repo.claimAiEnrichment(item!.itemId, lease("worker-a", 0, 60_000)));
    assert.equal(await repo.claimAiEnrichment(item!.itemId, lease("worker-b", 59_999)), false);
    assert.equal(await repo.claimAiEnrichment(item!.itemId, lease("worker-a", 30_000)), true, "renewal");
    // Releasing someone else's claim does nothing.
    await repo.releaseAiEnrichmentClaim(item!.itemId, "worker-b");
    assert.deepEqual(claimsTable(), [{ archive_item_id: item!.itemId, worker_id: "worker-a" }]);
  });

  test("an expired claim can be taken over", async () => {
    const [item] = await candidates();
    assert.ok(await repo.claimAiEnrichment(item!.itemId, lease("crashed-worker", 0, 60_000)));
    assert.equal(await repo.claimAiEnrichment(item!.itemId, lease("worker-b", 60_000)), true);
    assert.deepEqual(claimsTable(), [{ archive_item_id: item!.itemId, worker_id: "worker-b" }]);
  });

  test("a claim must expire after it is made", async () => {
    const [item] = await candidates();
    await assert.rejects(repo.claimAiEnrichment(item!.itemId, { workerId: "w", now: at(0), expiresAt: at(0) }), /expire after/);
  });

  test("claims leave eligibility unchanged: an actively claimed item is only passed over while held", async () => {
    const before = await candidates();
    const held = before[0]!.itemId;
    await repo.claimAiEnrichment(held, lease("worker-a", 0, 60_000));
    // Without unclaimedAt, the candidate list (the eligibility rules) is exactly as before.
    assert.deepEqual(await candidates(), before);
    const unclaimed = await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES, unclaimedAt: at(1_000) });
    assert.deepEqual(unclaimed.filter(isEnrichmentCandidate).map((c) => c.itemId), before.map((c) => c.itemId).filter((i) => i !== held));
    // Once the claim expires — or is released — the item is a candidate again.
    const later = await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES, unclaimedAt: at(60_000) });
    assert.ok(later.some((c) => c.itemId === held));
    await repo.releaseAiEnrichmentClaim(held, "worker-a");
    assert.deepEqual(claimsTable(), []);
  });

  test("the lease duration comes from AI_ENRICHMENT_LEASE_MS", () => {
    assert.equal(aiEnrichmentLeaseMsFromEnv({}), DEFAULT_AI_ENRICHMENT_LEASE_MS);
    assert.equal(DEFAULT_AI_ENRICHMENT_LEASE_MS, 600_000);
    assert.equal(aiEnrichmentLeaseMsFromEnv({ AI_ENRICHMENT_LEASE_MS: "90000" }), 90_000);
    for (const bad of ["0", "-5", "1.5", "ten"]) assert.throws(() => aiEnrichmentLeaseMsFromEnv({ AI_ENRICHMENT_LEASE_MS: bad }), /positive integer/);
  });
});

describe("enrichment batches with claims", () => {
  const storage = () => new LocalMediaStorage(join(dir, "media"));
  const service = (repository: SqliteArchiveRepository, provider: OrganizationProvider) =>
    new AiEnrichmentService({ repository, storage: storage(), provider, tempRoot: dir, now: () => T0 });
  const claims = (workerId: string) => ({ workerId, leaseMs: 60_000, now: () => new Date(T0) });

  test("a completed item's claim is released", async () => {
    const provider = new SlowProvider();
    const summary = await runEnrichmentBatch({ service: service(repo, provider), repository: repo, ownerId: OWNER, limit: 2, claims: claims("worker-a") });
    assert.equal(summary.enriched, 2);
    assert.deepEqual(claimsTable(), []);
  });

  test("a failed item's claim is released, and the item stays eligible for a retry", async () => {
    const provider = new SlowProvider();
    provider.fail = true;
    const [first] = await selectItemsForEnrichment({ repository: repo, ownerId: OWNER, limit: 1 });
    const summary = await runEnrichmentBatch({ service: service(repo, provider), repository: repo, ownerId: OWNER, limit: 1, claims: claims("worker-a") });
    assert.equal(summary.failed, 1);
    assert.deepEqual(claimsTable(), []);
    assert.ok((await candidates()).some((c) => c.itemId === first));
  });

  test("an item another worker holds is passed over, and the batch takes the next one", async () => {
    const order = await selectItemsForEnrichment({ repository: repo, ownerId: OWNER, limit: 100 });
    assert.ok(order.length >= 2);
    await repo.claimAiEnrichment(order[0]!, lease("worker-b", 0, 60_000));
    const provider = new SlowProvider();
    // Asks for as many items as there are: the held one is passed over, every other one is done.
    const summary = await runEnrichmentBatch({ service: service(repo, provider), repository: repo, ownerId: OWNER, limit: order.length, claims: claims("worker-a") });
    assert.equal(summary.attempted, order.length - 1);
    assert.ok(summary.results.every((r) => r.itemId !== order[0]));
    assert.deepEqual(claimsTable(), [{ archive_item_id: order[0], worker_id: "worker-b" }], "the other worker's claim is untouched");
  });

  test("two workers enriching the same archive concurrently create no duplicate organizations", async () => {
    const b = otherWorker();
    try {
      const all = (await candidates()).length;
      const [pa, pb] = [new SlowProvider(), new SlowProvider()];
      const [sa, sb] = await Promise.all([
        runEnrichmentBatch({ service: service(repo, pa), repository: repo, ownerId: OWNER, limit: 100, claims: claims("worker-a") }),
        runEnrichmentBatch({ service: service(b.repo, pb), repository: b.repo, ownerId: OWNER, limit: 100, claims: claims("worker-b") }),
      ]);
      const orgs = organizations();
      assert.ok(orgs.length > 1);
      assert.ok(orgs.every((o) => o.n === 1), `duplicates: ${JSON.stringify(orgs.filter((o) => o.n > 1))}`);
      assert.equal(pa.calls.length + pb.calls.length, sa.attempted + sb.attempted, "no item was sent to the provider twice");
      const enriched = [...sa.results, ...sb.results].filter((r) => r.status === "enriched").map((r) => r.itemId);
      assert.equal(new Set(enriched).size, enriched.length);
      assert.ok(sa.attempted > 0 && sb.attempted > 0, "both workers did work");
      assert.ok(sa.attempted + sb.attempted <= all);
      assert.deepEqual(claimsTable(), []);
    } finally {
      b.close();
    }
  });

  test("a worker whose lease expired and was taken over cannot save a duplicate", async () => {
    const [item] = await candidates();
    const id = item!.itemId as ArchiveItemId;
    // Worker A claims, then stalls past its lease; worker B takes the item over and enriches it.
    await repo.claimAiEnrichment(id, lease("worker-a", 0, 1_000));
    await repo.claimAiEnrichment(id, lease("worker-b", 2_000, 60_000));
    const b = await service(repo, new SlowProvider()).enrich(id, { workerId: "worker-b" });
    assert.equal(b.status, "enriched");
    // A finally gets its answer: its claim is gone, so nothing is saved. (B's organization already made the item ineligible.)
    const a = await service(repo, new SlowProvider()).enrich(id, { workerId: "worker-a" });
    assert.equal(a.status, "skipped");
    assert.deepEqual(organizations().filter((o) => o.archive_item_id === id), [{ archive_item_id: id, n: 1 }]);
  });

  test("a stale worker is refused at save time even while the item still looks eligible", async () => {
    const [item] = await candidates();
    const id = item!.itemId as ArchiveItemId;
    await repo.claimAiEnrichment(id, lease("worker-b", 0, 60_000));
    // Worker A no longer holds a claim (it was taken over), but the item has no organization yet.
    const a = await service(repo, new SlowProvider()).enrich(id, { workerId: "worker-a" });
    assert.deepEqual([a.status, a.status === "skipped" && a.reason], ["skipped", "the enrichment claim was taken over by another worker; nothing saved"]);
    assert.deepEqual(organizations().filter((o) => o.archive_item_id === id), []);
  });
});
