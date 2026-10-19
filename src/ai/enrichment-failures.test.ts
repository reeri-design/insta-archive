import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, UserId } from "../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../persistence/sqlite/database.ts";
import { MIGRATIONS } from "../persistence/sqlite/migrations.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { runEnrichmentBatch, selectItemsForEnrichment } from "./enrichment-batch.ts";
import { classifyEnrichmentFailure, temporaryRetryDelayMs } from "./enrichment-failure.ts";
import { isEnrichmentCandidate } from "./enrichment-eligibility.ts";
import { AiEnrichmentService, type EnrichmentResult } from "./enrichment-service.ts";
import { AiProviderError } from "./organization-provider.ts";
import { OpenRouterOrganizationProvider } from "./providers/openrouter-organization-provider.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const T0 = "2026-10-07T12:00:00.000Z";
const GOOD = {
  type: "inspiration", category: "craft", tags: ["embroidery", "sketchbook", "floral motifs"],
  summary: "An embroidered sketchbook page.", usefulFor: ["stitch reference"], confidence: 0.8,
};

// What OpenRouter actually answers (shapes from the real 3-worker run).
const atlasCloud400 = () =>
  new Response(JSON.stringify({ error: { message: "Provider returned error", code: 400, metadata: { raw: '{"code":400,"msg":"bad request"}', provider_name: "AtlasCloud", is_byok: false } } }), { status: 400 });
const upstream502In200 = () =>
  new Response(JSON.stringify({ error: { message: "JSON error injected into SSE stream", code: 502, metadata: { error_type: "provider_unavailable" } } }), { status: 200 });
const status = (code: number) => () => new Response(JSON.stringify({ error: { message: "upstream", code } }), { status: code });
const networkDown = () => { throw new TypeError("fetch failed: connection reset"); };
const success = () =>
  new Response(JSON.stringify({ model: "dots-test", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(GOOD) } }] }), { status: 200 });

/** An OpenRouter provider whose HTTP answers come from `answer` (per item, by call); counts calls per item. */
function provider(answer: (itemContent: string, call: number) => Response) {
  const calls = new Map<string, number>();
  let total = 0;
  const p = new OpenRouterOrganizationProvider({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: { type: string; text?: string }[] | string }[] };
      const content = (body.messages[1]!.content as { type: string; text?: string }[]).find((c) => c.type === "text")!.text!;
      const n = (calls.get(content) ?? 0) + 1;
      calls.set(content, n);
      total++;
      await new Promise((resolve) => setTimeout(resolve, 3));
      return answer(content, n);
    },
  });
  return { provider: p, calls, total: () => total };
}

let dir: string;
let path: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-failures-"));
  path = join(dir, "test.sqlite");
  db = openDatabase(path);
  repo = new SqliteArchiveRepository(db);
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: T0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (repository: SqliteArchiveRepository, p: OpenRouterOrganizationProvider) =>
  new AiEnrichmentService({ repository, storage: new LocalMediaStorage(join(dir, "media")), provider: p, tempRoot: dir, now: () => T0 });
/** Minutes after T0, as an ISO time. */
const after = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const claims = (workerId: string, at = T0) => ({ workerId, leaseMs: 60_000, now: () => new Date(at) });
const batch = (p: OpenRouterOrganizationProvider, extra: Partial<Parameters<typeof runEnrichmentBatch>[0]> = {}, r = repo) =>
  runEnrichmentBatch({ service: service(r, p), repository: r, ownerId: OWNER, limit: 100, claims: claims("worker-a"), ...extra });
const rows = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
const failures = () => rows("SELECT archive_item_id, category, status_code, provider, error_code, attempts FROM ai_enrichment_failures ORDER BY 1");
const retryTimes = () => rows("SELECT archive_item_id, category, next_retry_at FROM ai_enrichment_failures ORDER BY 1");
const claimsLeft = () => rows("SELECT * FROM ai_enrichment_claims");
const eligible = async (at = T0) => selectItemsForEnrichment({ repository: repo, ownerId: OWNER, limit: 100, retryableAt: at });
const shortcodeOf = async (id: ArchiveItemId) => {
  const item = await repo.getArchiveItem(id);
  return item?.identity.kind === "shortcode" ? item.identity.shortcode : "";
};

describe("classifying enrichment failures", () => {
  const failed = (kind: Extract<EnrichmentResult, { status: "failed" }>["kind"], details?: AiProviderError["details"], p = "openrouter") =>
    ({ status: "failed", itemId: "x" as ArchiveItemId, kind, reason: "r", provider: p, ...(details && { details }) }) as Extract<EnrichmentResult, { status: "failed" }>;

  test("400 from OpenRouter → provider_rejected; 502/503/504 and network → temporary; anything else → unknown", () => {
    assert.equal(classifyEnrichmentFailure(failed("provider_error", { status: 400, upstreamProvider: "AtlasCloud" })), "provider_rejected");
    for (const code of [502, 503, 504]) assert.equal(classifyEnrichmentFailure(failed("provider_error", { status: code })), "temporary");
    assert.equal(classifyEnrichmentFailure(failed("provider_error", { network: true })), "temporary");
    assert.equal(classifyEnrichmentFailure(failed("provider_error", { status: 500 })), "unknown");
    assert.equal(classifyEnrichmentFailure(failed("provider_error")), "unknown");
    assert.equal(classifyEnrichmentFailure(failed("invalid_output")), "unknown");
    assert.equal(classifyEnrichmentFailure(failed("refusal")), "unknown");
    assert.equal(classifyEnrichmentFailure(failed("provider_error", { status: 400 }, "gemini")), "unknown", "only the OpenRouter path's 400 is a rejection");
  });

  test("a rate limit and missing credentials are not recorded against the item", () => {
    assert.equal(classifyEnrichmentFailure(failed("rate_limited", { status: 429 })), undefined);
    assert.equal(classifyEnrichmentFailure(failed("authentication", { status: 401 })), undefined);
  });

  test("the OpenRouter provider reports the HTTP status, the upstream provider and network failures", async () => {
    const request = { instructions: "i", content: "c", images: [], outputSchema: {} };
    const errorOf = async (answer: () => Response) => {
      const { provider: p } = provider(answer);
      try {
        await p.organize(request);
      } catch (error) {
        return error as AiProviderError;
      }
      throw new Error("expected a failure");
    };
    assert.deepEqual((await errorOf(atlasCloud400)).details, { status: 400, upstreamProvider: "AtlasCloud" });
    assert.deepEqual((await errorOf(upstream502In200)).details, { status: 502 });
    assert.deepEqual((await errorOf(networkDown)).details, { network: true });
    const limited = await errorOf(status(429));
    assert.deepEqual([limited.kind, limited.details.status], ["rate_limited", 429]);
  });
});

describe("persistent enrichment failures", () => {
  test("a 400 is persisted and the item is no longer selected by normal runs", async () => {
    const before = await eligible();
    const { provider: p, total } = provider(atlasCloud400);
    const summary = await batch(p, { limit: 1 });
    const [rejected] = before;
    assert.equal(summary.failed, 1);
    assert.deepEqual(failures(), [{ archive_item_id: rejected, category: "provider_rejected", status_code: 400, provider: "AtlasCloud", error_code: "provider_error", attempts: 1 }]);
    assert.ok(!(await eligible()).includes(rejected!), "not selected again");
    // The eligibility rules themselves are unchanged: it is still a candidate in the repository's terms.
    assert.ok((await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES })).filter(isEnrichmentCandidate).some((c) => c.itemId === rejected));
    // A later normal run never sends it to the provider.
    const again = await batch(provider(success).provider);
    assert.ok(again.results.every((r) => r.itemId !== rejected));
    assert.equal(total(), 1);
    assert.deepEqual(claimsLeft(), []);
  });

  test("another worker that chose the item before the 400 was recorded does not retry it", async () => {
    const b = openDatabase(path);
    try {
      const repoB = new SqliteArchiveRepository(b);
      // Both workers start together with the same candidate list; every call is rejected.
      const a = provider(atlasCloud400);
      const bb = provider(atlasCloud400);
      const [sa, sb] = await Promise.all([batch(a.provider), batch(bb.provider, { claims: claims("worker-b") }, repoB)]);
      const sent = new Map<string, number>();
      for (const m of [a.calls, bb.calls]) for (const [k, n] of m) sent.set(k, (sent.get(k) ?? 0) + n);
      assert.ok([...sent.values()].every((n) => n === 1), "no item was sent to the provider twice");
      assert.equal(a.total() + bb.total(), failures().length);
      assert.ok(sa.providerRejected + sb.providerRejected + sa.claimedElsewhere + sb.claimedElsewhere > 0, "the other worker passed them over");
      assert.ok(failures().every((f) => f.category === "provider_rejected" && f.attempts === 1));
      assert.deepEqual(claimsLeft(), []);
    } finally {
      b.close();
    }
  });

  for (const [name, answer, code] of [
    ["502 (inside an HTTP 200)", upstream502In200, 502],
    ["503", status(503), 503],
    ["504", status(504), 504],
    ["a network failure", networkDown, null],
  ] as const) {
    test(`${name} is recorded as temporary and retried after its backoff`, async () => {
      const [first] = await eligible();
      await batch(provider(answer).provider, { limit: 1 });
      assert.deepEqual(failures(), [{ archive_item_id: first, category: "temporary", status_code: code, provider: "openrouter", error_code: "provider_error", attempts: 1 }]);
      assert.deepEqual(retryTimes(), [{ archive_item_id: first, category: "temporary", next_retry_at: after(1) }]);
      assert.ok(!(await eligible(T0)).includes(first!), "not right away");
      assert.equal((await eligible(after(1)))[0], first, "selectable again, in the same place, once its retry time comes");
      await batch(provider(answer).provider, { limit: 1, claims: claims("worker-a", after(1)) });
      assert.equal(failures()[0]?.attempts, 2, "a second failure is counted");
      assert.deepEqual(claimsLeft(), []);
    });
  }

  test("a success clears an earlier failure", async () => {
    const [first] = await eligible();
    await batch(provider(status(503)).provider, { limit: 1 });
    assert.equal(failures().length, 1);
    const summary = await batch(provider(success).provider, { limit: 1, claims: claims("worker-a", after(1)) });
    assert.deepEqual(summary.results.map((r) => [r.itemId, r.status]), [[first, "enriched"]]);
    assert.deepEqual(failures(), []);
    assert.equal(rows(`SELECT COUNT(*) AS n FROM ai_organizations WHERE archive_item_id = '${first}'`)[0]?.n, 1);
    assert.deepEqual(claimsLeft(), []);
  });

  test("a rejected item can still be retried explicitly, and a success then clears its failure", async () => {
    const [first] = await eligible();
    await batch(provider(atlasCloud400).provider, { limit: 1 });
    const explicit = await batch(provider(success).provider, { limit: 1, shortcodes: [await shortcodeOf(first!)] });
    assert.deepEqual([explicit.enriched, explicit.providerRejected], [1, 0]);
    assert.deepEqual(failures(), []);
  });

  test("a rate limit stops the run and records nothing against the item", async () => {
    const summary = await batch(provider(status(429)).provider);
    assert.deepEqual([summary.attempted, summary.rateLimited], [1, true]);
    assert.deepEqual(failures(), []);
    assert.deepEqual(claimsLeft(), []);
  });

  test("two concurrent workers with mixed outcomes create no duplicate organizations and leave no claims", async () => {
    const b = openDatabase(path);
    try {
      const repoB = new SqliteArchiveRepository(b);
      // Every third item is rejected, every other one succeeds.
      const mixed = (content: string) => (content.length % 3 === 0 ? atlasCloud400() : success());
      const a = provider(mixed);
      const bb = provider(mixed);
      await Promise.all([batch(a.provider), batch(bb.provider, { claims: claims("worker-b") }, repoB)]);
      const orgs = rows("SELECT archive_item_id, COUNT(*) AS n FROM ai_organizations GROUP BY 1") as { n: number }[];
      assert.ok(orgs.length > 0);
      assert.ok(orgs.every((o) => o.n === 1), "one organization per item");
      const sent = new Map<string, number>();
      for (const m of [a.calls, bb.calls]) for (const [k, n] of m) sent.set(k, (sent.get(k) ?? 0) + n);
      assert.ok([...sent.values()].every((n) => n === 1), "no item sent twice");
      assert.deepEqual(claimsLeft(), []);
    } finally {
      b.close();
    }
  });
});

describe("backoff for temporary failures", () => {
  test("the schedule: 1, 5, 15, then 30 minutes", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => temporaryRetryDelayMs(n) / 60_000), [1, 5, 15, 30, 30, 30]);
  });

  test("failures in a row wait 1, 5, 15 and 30 minutes, each from the moment it failed", async () => {
    const [first] = await eligible();
    const expected: [number, number][] = [[0, 1], [1, 6], [6, 21], [21, 51], [51, 81]]; // [failed at, retry at] in minutes after T0
    for (const [failedAt, retryAt] of expected) {
      assert.equal((await eligible(after(failedAt)))[0], first, `selectable at +${failedAt} min`);
      await batch(provider(status(502)).provider, { limit: 1, claims: claims("worker-a", after(failedAt)) });
      assert.deepEqual(retryTimes(), [{ archive_item_id: first, category: "temporary", next_retry_at: after(retryAt) }]);
    }
    assert.equal(failures()[0]?.attempts, 5);
    assert.deepEqual(claimsLeft(), []);
  });

  test("excluded before its retry time, selectable from it on", async () => {
    const [first] = await eligible();
    await batch(provider(status(502)).provider, { limit: 1 });
    assert.ok(!(await eligible(after(0.99))).includes(first!));
    assert.ok((await eligible(after(1))).includes(first!), "exactly at the retry time");
    assert.ok((await eligible(after(2))).includes(first!));
    // A batch before the retry time does not send it; one after does.
    const early = await batch(provider(success).provider, { limit: 1, claims: claims("worker-a", after(0.5)) });
    assert.ok(early.results.every((r) => r.itemId !== first));
    const late = await batch(provider(success).provider, { limit: 1, claims: claims("worker-a", after(1)) });
    assert.equal(late.results[0]?.itemId, first);
  });

  test("a worker that chose the item before it failed elsewhere respects the retry time", async () => {
    const order = await eligible();
    const first = order[0]!;
    const b = openDatabase(path);
    try {
      const repoB = new SqliteArchiveRepository(b);
      // Worker B chooses its items now, but its first claim waits until worker A has failed on the
      // first item (temporary): B's list still has the item; the stored retry time must stop it.
      let aFailed!: () => void;
      const gate = new Promise<void>((resolve) => (aFailed = resolve));
      const gatedB: SqliteArchiveRepository = Object.assign(Object.create(repoB) as SqliteArchiveRepository, {
        claimAiEnrichment: async (...args: Parameters<SqliteArchiveRepository["claimAiEnrichment"]>) => {
          await gate;
          return repoB.claimAiEnrichment(...args);
        },
      });
      const pa = provider(status(504));
      const pb = provider(success);
      const sb = runEnrichmentBatch({ service: service(repoB, pb.provider), repository: gatedB, ownerId: OWNER, limit: 1, claims: claims("worker-b") });
      await batch(pa.provider, { limit: 1 });
      aFailed();
      const summary = await sb;
      assert.equal(summary.backingOff, 1, "B passed over the item that is backing off");
      assert.ok(summary.results.every((r) => r.itemId !== first));
      assert.equal(pa.total() + pb.total(), 2, "A's failed call and B's call on another item; the failed item was not sent again");
      assert.deepEqual(claimsLeft(), []);
    } finally {
      b.close();
    }
  });

  test("two concurrent workers never send a temporary failure again before its retry time", async () => {
    const b = openDatabase(path);
    try {
      const repoB = new SqliteArchiveRepository(b);
      const a = provider(upstream502In200);
      const bb = provider(upstream502In200);
      await Promise.all([batch(a.provider), batch(bb.provider, { claims: claims("worker-b") }, repoB)]);
      const sent = new Map<string, number>();
      for (const m of [a.calls, bb.calls]) for (const [k, n] of m) sent.set(k, (sent.get(k) ?? 0) + n);
      assert.ok([...sent.values()].every((n) => n === 1), "each item failed once and then waited");
      assert.ok(failures().every((f) => f.category === "temporary" && f.attempts === 1));
      assert.deepEqual(claimsLeft(), []);
    } finally {
      b.close();
    }
  });

  test("a provider-rejected item stays excluded, however much later", async () => {
    const [first] = await eligible();
    await batch(provider(atlasCloud400).provider, { limit: 1 });
    assert.deepEqual(retryTimes(), [{ archive_item_id: first, category: "provider_rejected", next_retry_at: null }]);
    assert.ok(!(await eligible(after(60 * 24 * 365))).includes(first!));
  });

  test("an unknown failure is not delayed", async () => {
    const [first] = await eligible();
    await batch(provider(status(500)).provider, { limit: 1 });
    assert.deepEqual(retryTimes(), [{ archive_item_id: first, category: "unknown", next_retry_at: null }]);
    assert.equal((await eligible(T0))[0], first);
  });
});

describe("migration 7", () => {
  test("gives temporary failures recorded before it a retry time on the same schedule; other categories none", () => {
    // No archive items here: foreign keys off, so the failure rows can stand alone.
    const old = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      // A database at version 6, with failures recorded the old way.
      for (const sql of MIGRATIONS.slice(0, 6)) old.exec(sql);
      old.exec("PRAGMA user_version = 6");
      const insert = old.prepare(
        "INSERT INTO ai_enrichment_failures (archive_item_id, category, error_code, message, failed_at, attempts) VALUES (?, ?, 'provider_error', 'm', ?, ?)",
      );
      insert.run("t1", "temporary", "2026-10-07T08:00:00.000Z", 1);
      insert.run("t2", "temporary", "2026-10-07T08:00:00.000Z", 2);
      insert.run("t3", "temporary", "2026-10-07T08:00:00.000Z", 3);
      insert.run("t7", "temporary", "2026-10-07T08:00:00.000Z", 7);
      insert.run("r1", "provider_rejected", "2026-10-07T08:00:00.000Z", 1);
      insert.run("u1", "unknown", "2026-10-07T08:00:00.000Z", 1);
      migrate(old);
      const after = old.prepare("SELECT archive_item_id AS id, next_retry_at AS at FROM ai_enrichment_failures ORDER BY 1").all().map((r) => ({ ...r }));
      assert.deepEqual(after, [
        { id: "r1", at: null },
        { id: "t1", at: "2026-10-07T08:01:00.000Z" },
        { id: "t2", at: "2026-10-07T08:05:00.000Z" },
        { id: "t3", at: "2026-10-07T08:15:00.000Z" },
        { id: "t7", at: "2026-10-07T08:30:00.000Z" },
        { id: "u1", at: null },
      ]);
    } finally {
      old.close();
    }
  });
});
