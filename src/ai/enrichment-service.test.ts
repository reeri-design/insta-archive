import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, MediaAsset, MediaAssetId, UserId } from "../domain/archive-item.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import type { FrameExtractor } from "../media/instagram/reel-media.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { storageKeyFor } from "../media/media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { representativeSample, runEnrichmentBatch } from "./enrichment-batch.ts";
import { AiEnrichmentService } from "./enrichment-service.ts";
import { ORGANIZATION_INSTRUCTIONS } from "./organization-prompt.ts";
import { GeminiOrganizationProvider, type GeminiModelsClient } from "./providers/gemini-organization-provider.ts";
import {
  AiProviderError,
  type OrganizationProvider,
  type OrganizationRequest,
  type OrganizationResponse,
} from "./organization-provider.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const T0 = "2026-10-03T12:00:00.000Z";
const id = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;
const GOOD = {
  type: "inspiration", category: "craft", tags: ["embroidery", "sketchbook", "floral motifs"],
  summary: "An embroidered sketchbook page.", usefulFor: ["stitch reference"], confidence: 0.8,
};

/** Provider stand-in: records requests, returns or throws what it is told. */
class FakeProvider implements OrganizationProvider {
  readonly provider = "fake-ai";
  readonly model = "fake-model-1";
  requests: OrganizationRequest[] = [];
  answer: () => Promise<OrganizationResponse> = async () => ({ output: GOOD, model: "fake-model-1", usage: { inputTokens: 100, outputTokens: 20 } });
  async organize(request: OrganizationRequest): Promise<OrganizationResponse> {
    this.requests.push(request);
    return this.answer();
  }
}

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;
let storage: LocalMediaStorage;
let provider: FakeProvider;
let tempRoot: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-ai-"));
  tempRoot = join(dir, "tmp");
  mkdirSync(tempRoot);
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
  storage = new LocalMediaStorage(join(dir, "media"));
  provider = new FakeProvider();
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: T0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (frameExtractor?: FrameExtractor) =>
  new AiEnrichmentService({ repository: repo, storage, provider, tempRoot, now: () => T0, ...(frameExtractor && { frameExtractor }) });
const snapshot = () =>
  Object.fromEntries(["archive_items", "source_records", "original_metadata", "media_assets", "ai_organizations", "curated_organizations", "media_retrieval_requests"]
    .map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));

/** MediaAsset without its retrieval state, per variant (content / derived_frame). */
type AssetShape = MediaAsset extends infer M ? (M extends unknown ? Omit<M, "retrieval"> : never) : never;

/** Stores bytes and the matching stored MediaAsset. */
async function storeAsset(asset: AssetShape, mimeType: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const key = storageKeyFor(asset.archiveItemId, asset.id, mimeType);
  await storage.put(key, bytes);
  await repo.saveMediaAssets([{ ...asset, retrieval: { status: "stored", storageKey: key, mimeType, retrievedAt: T0, ...extra } } as MediaAsset]);
}

describe("AiEnrichmentService", () => {
  test("persists a validated, immutable AiOrganization with its provenance", async () => {
    const result = await service().enrich(id("PostCCC333"));
    assert.equal(result.status, "enriched");
    const [stored] = (await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions ?? [];
    assert.deepEqual(stored, {
      id: `${id("PostCCC333")}:ai:${T0}`,
      archiveItemId: id("PostCCC333"),
      fields: { type: "inspiration", category: "craft", tags: ["embroidery", "sketchbook", "floral motifs"], summary: "An embroidered sketchbook page.", usefulFor: ["stitch reference"] },
      confidence: 0.8,
      taxonomyVersion: "v1",
      provider: "fake-ai",
      model: "fake-model-1",
      promptVersion: "organize-v1/metadata",
      createdAt: T0,
    });
  });

  test("never touches original metadata or curation", async () => {
    await repo.appendAiOrganization({ id: "seed" as never, archiveItemId: id("ReelAAA111"), fields: { tags: [], usefulFor: [] }, confidence: 0.5, taxonomyVersion: "v0", provider: "x", model: "x", promptVersion: "x", createdAt: T0 });
    await repo.saveCuratedOrganization({ archiveItemId: id("ReelAAA111"), fields: { tags: ["mine"], usefulFor: [] }, fieldOrigins: { tags: "human_added" }, taxonomyVersion: "v0", reviewedBy: OWNER, reviewedAt: T0 });
    const before = snapshot();
    await service().enrich(id("PostCCC333"));
    const after = snapshot();
    for (const table of Object.keys(before).filter((t) => t !== "ai_organizations")) {
      assert.deepEqual(after[table], before[table], table);
    }
  });

  test("metadata-only: original context goes in, DM context and saving reasons do not", async () => {
    await service().enrich(id("ReelAAA111"));
    const [request] = provider.requests;
    assert.ok(request);
    assert.deepEqual(request.images, []);
    assert.match(request.content, /Instagram content kind: reel/);
    assert.match(request.content, /Creator: Zoë Example @example_artist/);
    assert.match(request.content, /it’s a sketchbook tour 🎨/);
    assert.match(request.content, /Media: not available/);
    for (const hidden of ["Friend", "Owner’s Studio", "saved", "liked", "message", "inbox"]) {
      assert.ok(!request.content.includes(hidden), `content must not mention "${hidden}"`);
    }
    assert.match(request.instructions, /Never guess, state or imply why the owner saved/);
    assert.match(request.instructions, /Use "other" whenever none clearly fits/);
    assert.equal((await repo.getArchiveItemAggregate(id("ReelAAA111")))?.aiSuggestions[0]?.promptVersion, "organize-v1/metadata");
  });

  test("media + metadata: carousel slides are sent in order", async () => {
    for (const position of [2, 0, 1]) {
      await storeAsset({ id: `${id("CarouBBB222")}:media:${position}` as MediaAssetId, archiveItemId: id("CarouBBB222"), mediaType: "image", role: "content", position }, "image/jpeg", new TextEncoder().encode(`slide ${position}`));
    }
    const result = await service().enrich(id("CarouBBB222"));
    assert.deepEqual(result.status === "enriched" && [result.mediaUsed, result.imageCount], [true, 3]);
    const [request] = provider.requests;
    assert.deepEqual(request?.images.map((i) => new TextDecoder().decode(i.bytes)), ["slide 0", "slide 1", "slide 2"]);
    assert.match(request?.content ?? "", /3 images attached: carousel slides 1–3 of 3, in order/);
    assert.equal((await repo.getArchiveItemAggregate(id("CarouBBB222")))?.aiSuggestions[0]?.promptVersion, "organize-v1/media");
  });

  test("media + metadata: a frames-only Reel sends its stored frames in time order", async () => {
    for (const ms of [4000, 0, 8000]) {
      await storeAsset({ id: `${id("ReelAAA111")}:frame:${ms}` as MediaAssetId, archiveItemId: id("ReelAAA111"), mediaType: "image", role: "derived_frame", frameTimeMs: ms }, "image/png", new TextEncoder().encode(`frame ${ms}`));
    }
    await service().enrich(id("ReelAAA111"));
    assert.deepEqual(provider.requests[0]?.images.map((i) => new TextDecoder().decode(i.bytes)), ["frame 0", "frame 4000", "frame 8000"]);
    assert.match(provider.requests[0]?.content ?? "", /3 frames from the video, in time order \(at 0\.0s, 4\.0s, 8\.0s\)/);
  });

  test("media + metadata: a stored Reel video is sampled into temporary frames that are not kept", async () => {
    await storeAsset({ id: `${id("ReelAAA111")}:media:0` as MediaAssetId, archiveItemId: id("ReelAAA111"), mediaType: "video", role: "content", position: 0 }, "video/mp4", new TextEncoder().encode("mp4"));
    const extractor: FrameExtractor = {
      extract: async (_video, outDir) => {
        mkdirSync(outDir, { recursive: true });
        return [0, 4000].map((ms) => {
          const path = join(outDir, `${ms}.png`);
          writeFileSync(path, `sampled ${ms}`);
          return { frameTimeMs: ms, path, mimeType: "image/png" };
        });
      },
    };
    const mediaBefore = (await repo.getArchiveItemAggregate(id("ReelAAA111")))?.media;
    await service(extractor).enrich(id("ReelAAA111"));
    assert.deepEqual(provider.requests[0]?.images.map((i) => new TextDecoder().decode(i.bytes)), ["sampled 0", "sampled 4000"]);
    assert.deepEqual(readdirSync(tempRoot), []);
    assert.deepEqual((await repo.getArchiveItemAggregate(id("ReelAAA111")))?.media, mediaBefore); // no frames stored
  });

  test("media + metadata: a single image is sent with the metadata", async () => {
    await storeAsset({ id: `${id("PostCCC333")}:media:0` as MediaAssetId, archiveItemId: id("PostCCC333"), mediaType: "image", role: "content", position: 0 }, "image/jpeg", new TextEncoder().encode("the image"));
    const result = await service().enrich(id("PostCCC333"));
    assert.deepEqual(result.status === "enriched" && [result.mediaUsed, result.imageCount], [true, 1]);
    const [request] = provider.requests;
    assert.deepEqual(request?.images.map((i) => [i.mimeType, new TextDecoder().decode(i.bytes)]), [["image/jpeg", "the image"]]);
    assert.match(request?.content ?? "", /Caption:\n"""\ntype specimen, first draft\n"""/);
    assert.match(request?.content ?? "", /Media: 1 image attached \(the post's image\)\./);
    assert.equal((await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions[0]?.promptVersion, "organize-v1/media");
  });

  test("missing media falls back to exactly the metadata-only request", async () => {
    const metadataOnly = async () => {
      const fresh = new FakeProvider();
      await new AiEnrichmentService({ repository: repo, storage, provider: fresh, now: () => T0 }).enrich(id("PostCCC333"));
      return fresh.requests[0];
    };
    // Baseline on a copy of the state: no media rows at all.
    const before = snapshot();
    const baseline = await metadataOnly();
    db.prepare("DELETE FROM ai_organizations").run();
    assert.deepEqual(snapshot().ai_organizations, before.ai_organizations);

    // Media rows that are not usable: failed, unavailable, and stored-but-file-missing.
    const asset = (position: number) => ({ id: `${id("PostCCC333")}:media:${position}` as MediaAssetId, archiveItemId: id("PostCCC333"), mediaType: "image" as const, role: "content" as const, position });
    await repo.saveMediaAssets([
      { ...asset(0), retrieval: { status: "failed", lastAttemptAt: T0, attempts: 1, error: "network_error: reset" } },
      { ...asset(1), retrieval: { status: "unavailable", checkedAt: T0, reason: "deleted" } },
      { ...asset(2), retrieval: { status: "stored", storageKey: "aa/missing/file.jpg", mimeType: "image/jpeg", retrievedAt: T0 } },
    ]);
    const fallback = await metadataOnly();
    assert.deepEqual(fallback, baseline);
    assert.deepEqual(fallback?.images, []);
    assert.equal((await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions[0]?.promptVersion, "organize-v1/metadata");
  });

  test("images the provider cannot accept are left out, and the description names the slides sent", async () => {
    const noGifProvider = new FakeProvider();
    Object.assign(noGifProvider, { supportedImageTypes: ["image/jpeg", "image/png", "image/webp"] });
    for (const [position, type] of [[0, "image/gif"], [1, "image/jpeg"], [2, "image/jpeg"]] as const) {
      await storeAsset({ id: `${id("CarouBBB222")}:media:${position}` as MediaAssetId, archiveItemId: id("CarouBBB222"), mediaType: "image", role: "content", position }, type, new TextEncoder().encode(`slide ${position}`));
    }
    await new AiEnrichmentService({ repository: repo, storage, provider: noGifProvider, now: () => T0 }).enrich(id("CarouBBB222"));
    const [request] = noGifProvider.requests;
    assert.deepEqual(request?.images.map((i) => new TextDecoder().decode(i.bytes)), ["slide 1", "slide 2"]);
    assert.match(request?.content ?? "", /Media: 2 of the 3 carousel slides attached \(slides 2, 3\), in order\./);
  });

  test("an item with no caption and no media is skipped without calling the provider", async () => {
    const result = await service().enrich(id("BareDDD444"));
    assert.deepEqual([result.status, result.status === "skipped" && result.reason], ["skipped", "no caption or stored media to classify"]);
    assert.equal(provider.requests.length, 0);
  });

  test("an invalid AI response is not persisted", async () => {
    provider.answer = async () => ({ output: { ...GOOD, category: "memes", tags: ["one"] }, model: "fake-model-1" });
    const result = await service().enrich(id("PostCCC333"));
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.kind, "invalid_output");
      assert.match(result.reason, /category must be one of.*tags must have 3–7/);
    }
    assert.equal((await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions.length, 0);
  });

  test("an existing AiOrganization is never overwritten or duplicated", async () => {
    await service().enrich(id("PostCCC333"));
    const first = (await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions;
    provider.answer = async () => ({ output: { ...GOOD, category: "design" }, model: "fake-model-1" });
    const again = await service().enrich(id("PostCCC333"));
    assert.deepEqual([again.status, again.status === "skipped" && again.reason], ["skipped", "already has an AI organization"]);
    assert.equal(provider.requests.length, 1);
    assert.deepEqual((await repo.getArchiveItemAggregate(id("PostCCC333")))?.aiSuggestions, first);
  });

  test("provider errors leave the archive exactly as it was", async () => {
    const before = snapshot();
    for (const error of [new AiProviderError("refusal", "declined"), new AiProviderError("provider_error", "HTTP 500"), new Error("socket hang up")]) {
      provider.answer = async () => { throw error; };
      const result = await service().enrich(id("PostCCC333"));
      assert.equal(result.status, "failed");
    }
    assert.deepEqual(snapshot(), before);
  });
});

describe("end to end with the Gemini adapter (stubbed client)", () => {
  test("Gemini receives the metadata text first, then the carousel images in order", async () => {
    const calls: unknown[] = [];
    const client = {
      models: {
        generateContent: async (params: unknown) => {
          calls.push(params);
          return { text: JSON.stringify(GOOD), modelVersion: "gemini-test", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
        },
      },
    } as unknown as GeminiModelsClient;
    for (const position of [1, 0]) {
      await storeAsset({ id: `${id("CarouBBB222")}:media:${position}` as MediaAssetId, archiveItemId: id("CarouBBB222"), mediaType: "image", role: "content", position }, "image/png", new Uint8Array([position, 9]));
    }
    const gemini = new GeminiOrganizationProvider({ client });
    const result = await new AiEnrichmentService({ repository: repo, storage, provider: gemini, now: () => T0 }).enrich(id("CarouBBB222"));
    assert.equal(result.status, "enriched");

    const params = calls[0] as { model: string; contents: { parts: Record<string, unknown>[] }[]; config: Record<string, unknown> };
    const [text, ...images] = params.contents[0]?.parts ?? [];
    assert.match(String(text?.text), /Instagram content kind: carousel\nCreator: Poster Studio @poster\.studio\nCaption:\n"""\nfive poster studies, swipe for process\n"""\nMedia: 2 images attached: carousel slides 1–2 of 2, in order\./);
    assert.deepEqual(images, [
      { inlineData: { mimeType: "image/png", data: Buffer.from([0, 9]).toString("base64") } },
      { inlineData: { mimeType: "image/png", data: Buffer.from([1, 9]).toString("base64") } },
    ]);
    assert.equal(params.config.systemInstruction, ORGANIZATION_INSTRUCTIONS);
    assert.equal(params.config.responseMimeType, "application/json");
    const [saved] = (await repo.getArchiveItemAggregate(id("CarouBBB222")))?.aiSuggestions ?? [];
    assert.deepEqual([saved?.provider, saved?.model, saved?.promptVersion], ["gemini", "gemini-test", "organize-v1/media"]);
  });
});

describe("representative selection", () => {
  test("the candidate query reports kind, sources, creator and caption/media presence", async () => {
    const candidates = await repo.listAiEnrichmentCandidates(OWNER);
    const byId = new Map(candidates.map((c) => [c.itemId, c]));
    assert.deepEqual(byId.get(id("ReelAAA111")), {
      itemId: id("ReelAAA111"), kind: "reel", sources: ["liked", "messages", "saved"],
      latestAt: "2026-09-29T12:27:39.000Z", creatorUsername: "example_artist", hasCaption: true, hasStoredMedia: false,
    });
    assert.deepEqual([byId.get(id("BareDDD444"))?.hasCaption, byId.get(id("BareDDD444"))?.creatorUsername], [false, undefined]);
    await service().enrich(id("PostCCC333"));
    assert.ok(!(await repo.listAiEnrichmentCandidates(OWNER)).some((c) => c.itemId === id("PostCCC333")));
  });

  test("the sample spreads across kind/source groups and creators, deterministically", () => {
    const c = (n: number, kind: "reel" | "carousel" | "unknown", sources: ("liked" | "saved" | "messages")[], creator?: string, hasCaption = true) => ({
      itemId: `i${n}` as ArchiveItemId, kind, sources, ...(creator && { creatorUsername: creator }), hasCaption, hasStoredMedia: false,
    });
    const candidates = [ // newest first
      c(1, "reel", ["liked"], "ann"), c(2, "reel", ["liked"], "ann"), c(3, "reel", ["liked"], "bob"),
      c(4, "reel", ["liked"], "cat"), c(5, "carousel", ["messages"], "dan"), c(6, "unknown", ["saved"], "ann"),
      c(7, "unknown", ["saved"], "eve"), c(8, "reel", ["liked"], "fay", false),
    ];
    const sample = representativeSample(candidates, 5);
    // Round-robin over groups (largest first), preferring creators not yet picked; no-caption item never chosen.
    assert.deepEqual(sample, ["i1", "i7", "i5", "i3", "i6"]); // i7 (eve) before i6 (ann, already picked)
    assert.deepEqual(representativeSample(candidates, 5), sample);
    assert.equal(representativeSample(candidates, 50).length, 7);
    assert.ok(!representativeSample(candidates, 50).includes("i8" as ArchiveItemId));
  });

  test("items with stored media are selected before metadata-only items, still spread across groups and creators", () => {
    const c = (n: number, kind: "reel" | "carousel" | "post", sources: ("liked" | "saved" | "messages")[], creator: string, media: boolean, hasCaption = true) => ({
      itemId: `i${n}` as ArchiveItemId, kind, sources, creatorUsername: creator, hasCaption, hasStoredMedia: media,
    });
    const candidates = [ // newest first; the media items are deliberately the older ones
      c(1, "reel", ["liked"], "ann", false), c(2, "carousel", ["messages"], "bob", false), c(3, "post", ["saved"], "cat", false),
      c(4, "reel", ["liked"], "dan", true), c(5, "reel", ["liked"], "dan", true), c(6, "reel", ["liked"], "eve", true),
      c(7, "carousel", ["messages"], "fay", true, false), // media but no caption: still eligible
      c(8, "post", ["saved"], "gus", false, false), // neither: never chosen
    ];
    // Media tier first (round-robin: reel group, then carousel group; dan's second item after eve's).
    assert.deepEqual(representativeSample(candidates, 3), ["i4", "i7", "i6"]);
    // The rest of the limit is filled with metadata-only items, in the usual group order (equal sizes: by key).
    assert.deepEqual(representativeSample(candidates, 6), ["i4", "i7", "i6", "i5", "i2", "i3"]);
    const all = representativeSample(candidates, 50);
    assert.deepEqual(all, ["i4", "i7", "i6", "i5", "i2", "i3", "i1"]);
    // No metadata-only item comes before a media item.
    const withMedia = new Set(["i4", "i5", "i6", "i7"]);
    assert.ok(all.slice(0, 4).every((i) => withMedia.has(i)));
  });
});

describe("runEnrichmentBatch", () => {
  const batch = (extra: Partial<Parameters<typeof runEnrichmentBatch>[0]> = {}) =>
    runEnrichmentBatch({ service: service(), repository: repo, ownerId: OWNER, limit: 2, ...extra });

  test("requires a limit between 1 and 100", async () => {
    for (const limit of [0, -1, 101, 2.5, Number.NaN]) {
      await assert.rejects(batch({ limit }), /limit must be an integer from 1 to 100/);
    }
    assert.equal(provider.requests.length, 0);
  });

  test("processes at most the limit, skipping already-enriched items in the default selection", async () => {
    const first = await batch();
    assert.equal(first.attempted, 2);
    const second = await batch({ limit: 10 });
    const enrichedFirst = first.results.filter((r) => r.status === "enriched").map((r) => r.itemId);
    assert.ok(second.results.every((r) => !enrichedFirst.includes(r.itemId)), "enriched items are not picked again");
    // Every classifiable fixture item is now enriched; the two with neither caption nor
    // media (BareDDD444, ReplyEEE555) are never selected.
    const left = await runEnrichmentBatch({ service: service(), repository: repo, ownerId: OWNER, limit: 10 });
    assert.equal(left.attempted, 0);
    assert.equal(first.enriched + second.enriched, 3);
    assert.equal(first.inputTokens + second.inputTokens, 100 * (first.enriched + second.enriched));
  });

  test("named items are processed in the given order, capped at the limit", async () => {
    const summary = await batch({ shortcodes: ["CarouBBB222", "PostCCC333", "ReelAAA111"] });
    assert.deepEqual(summary.results.map((r) => r.itemId), [id("CarouBBB222"), id("PostCCC333")]);
    await assert.rejects(batch({ shortcodes: ["NoSuchPost"] }), /No archive item for shortcode NoSuchPost/);
  });

  test("missing or rejected credentials stop the batch", async () => {
    provider.answer = async () => { throw new AiProviderError("authentication", "no key"); };
    const summary = await batch({ limit: 5 });
    assert.equal(summary.stoppedForAuthentication, true);
    assert.equal(summary.failed, 1);
    assert.equal(provider.requests.length, 1);
  });

  test("a rate limit stops the batch", async () => {
    provider.answer = async () => { throw new AiProviderError("rate_limited", "429"); };
    const summary = await batch({ limit: 5 });
    assert.deepEqual([summary.attempted, summary.failed, summary.rateLimited], [1, 1, true]);
    assert.equal(provider.requests.length, 1);
  });
});
