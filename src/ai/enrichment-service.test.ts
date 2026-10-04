import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, MediaAsset, MediaAssetId, SourceKind, SourceRecordId, UserId } from "../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import type { FrameExtractor } from "../media/instagram/reel-media.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { storageKeyFor } from "../media/media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import { prioritizedSample, representativeSample, runEnrichmentBatch } from "./enrichment-batch.ts";
import { isEnrichmentCandidate } from "./enrichment-eligibility.ts";
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

  test("media + metadata: a Reel whose video was withheld is organized from its cover image, described as a cover", async () => {
    const reel = id("ReelAAA111");
    // As retrieval leaves it: the video recorded as unavailable, the cover stored.
    await repo.saveMediaAssets([{
      id: `${reel}:media:0` as MediaAssetId, archiveItemId: reel, mediaType: "video", role: "content", position: 0,
      retrieval: { status: "unavailable", checkedAt: T0, reason: "restricted", detail: "Embed page has no video URL" },
    }]);
    await storeAsset({ id: `${reel}:cover` as MediaAssetId, archiveItemId: reel, mediaType: "image", role: "cover" }, "image/jpeg", new TextEncoder().encode("cover"));

    const result = await service().enrich(reel);
    assert.ok(result.status === "enriched");
    assert.deepEqual([result.mediaUsed, result.imageCount, result.organization.promptVersion], [true, 1, "organize-v1/media"]);
    const [request] = provider.requests;
    assert.deepEqual(request?.images.map((i) => new TextDecoder().decode(i.bytes)), ["cover"]);
    assert.match(request?.content ?? "", /the post's published cover image \(a single still chosen by the creator, not a frame of the video, which could not be retrieved\)/);
  });

  test("the cover is only a last resort: stored content images are used instead", async () => {
    const carousel = id("CarouBBB222");
    await storeAsset({ id: `${carousel}:media:0` as MediaAssetId, archiveItemId: carousel, mediaType: "image", role: "content", position: 0 }, "image/jpeg", new TextEncoder().encode("slide"));
    await storeAsset({ id: `${carousel}:cover` as MediaAssetId, archiveItemId: carousel, mediaType: "image", role: "cover" }, "image/jpeg", new TextEncoder().encode("cover"));
    await service().enrich(carousel);
    assert.deepEqual(provider.requests[0]?.images.map((i) => new TextDecoder().decode(i.bytes)), ["slide"]);
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
    assert.deepEqual([again.status, again.status === "skipped" && again.reason], ["skipped", "already has an AI organization; no media stored since"]);
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
      latestAt: "2026-09-29T12:27:39.000Z", creatorUsername: "example_artist", hasCaption: true, hasStoredMedia: false, priority: "backfill",
    });
    assert.deepEqual([byId.get(id("BareDDD444"))?.hasCaption, byId.get(id("BareDDD444"))?.creatorUsername], [false, undefined]);
    await service().enrich(id("PostCCC333"));
    assert.ok(!(await repo.listAiEnrichmentCandidates(OWNER)).some((c) => c.itemId === id("PostCCC333")));
  });

  test("the sample spreads across kind/source groups and creators, deterministically", () => {
    const c = (n: number, kind: "reel" | "carousel" | "unknown", sources: ("liked" | "saved" | "messages")[], creator?: string, hasCaption = true) => ({
      itemId: `i${n}` as ArchiveItemId, kind, sources, ...(creator && { creatorUsername: creator }), hasCaption, hasStoredMedia: false, priority: "backfill" as const,
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
      itemId: `i${n}` as ArchiveItemId, kind, sources, creatorUsername: creator, hasCaption, hasStoredMedia: media, priority: "backfill" as const,
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

describe("enrichment lifecycle: media-aware re-enrichment (the ceramic snake Reel)", () => {
  // Modelled on DdyyEHMx-nw: first organized from its caption alone, its video was stored later.
  const SNAKE = id("DdyyEHMx-nw");
  const T_ORGANIZED = "2026-10-03T08:44:00.000Z";
  const T_MEDIA = "2026-10-03T09:55:00.000Z";
  const T_REENRICHED = "2026-10-03T16:00:00.000Z";
  const METADATA_ANSWER = { type: "inspiration", category: "craft", tags: ["snake", "cowboy hat", "figurine"], summary: "A cowboy snake figurine.", usefulFor: ["whimsical figurine ideas"], confidence: 0.5 };
  const MEDIA_ANSWER = { type: "inspiration", category: "craft", tags: ["ceramic", "clay sculpture", "match holder", "cowboy snake"], summary: "A handmade yellow ceramic snake in a cowboy hat that holds matches.", usefulFor: ["clay figurine reference"], confidence: 0.9 };
  const extractor: FrameExtractor = {
    extract: async (_video, outDir) => {
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, "0.png");
      writeFileSync(path, "snake frame");
      return [{ frameTimeMs: 0, path, mimeType: "image/png" }];
    },
  };
  const serviceAt = (now: string) =>
    new AiEnrichmentService({ repository: repo, storage, provider, tempRoot, frameExtractor: extractor, now: () => now });
  const candidates = async () =>
    (await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES })).filter(isEnrichmentCandidate).map((c) => c.itemId);
  const searchIds = async (q: string) =>
    (await repo.searchArchiveItems(OWNER, q, { sources: MAIN_ARCHIVE_SOURCES })).hits.map((h) => h.item.id);
  const storeVideo = (retrievedAt: string, mimeType = "video/mp4") =>
    storeAsset({ id: `${SNAKE}:media:0` as MediaAssetId, archiveItemId: SNAKE, mediaType: "video", role: "content", position: 0 }, mimeType, new TextEncoder().encode("mp4"), { retrievedAt });

  beforeEach(async () => {
    await repo.saveArchiveItem({
      id: SNAKE, ownerId: OWNER, identity: { kind: "shortcode", shortcode: "DdyyEHMx-nw" }, kind: "reel",
      canonicalUrl: "https://www.instagram.com/reel/DdyyEHMx-nw/", createdAt: T0, updatedAt: T0,
    });
    await repo.addSourceRecords([{
      id: "snake:messages" as SourceRecordId, archiveItemId: SNAKE, source: "messages", originalUrl: "https://www.instagram.com/reel/DdyyEHMx-nw/",
      occurredAt: "2026-10-01T00:00:00.000Z", exportLocation: { file: "messages.json" }, raw: {}, importedAt: T0,
    }]);
    await repo.saveOriginalMetadata(SNAKE, {
      caption: { value: "little cowboy snake 🤠 check out @aesthetic_arts_bygeorgia if you love snake friends!", provenance: { from: "export", sourceRecordId: "snake:messages" as SourceRecordId } },
    });
    // First enrichment: no media yet, so metadata-only.
    provider.answer = async () => ({ output: METADATA_ANSWER, model: "fake-model-1" });
    const first = await serviceAt(T_ORGANIZED).enrich(SNAKE);
    assert.deepEqual([first.status, first.status === "enriched" && first.organization.promptVersion], ["enriched", "organize-v1/metadata"]);
    provider.requests = [];
    provider.answer = async () => ({ output: MEDIA_ANSWER, model: "fake-model-1" });
  });

  test("while nothing changes, a metadata-only organization is not redone", async () => {
    const again = await serviceAt(T_REENRICHED).enrich(SNAKE);
    assert.deepEqual([again.status, again.status === "skipped" && again.reason], ["skipped", "already has an AI organization; no media stored since"]);
    assert.ok(!(await candidates()).includes(SNAKE));
    assert.equal(provider.requests.length, 0);
  });

  test("failed or unavailable media does not make it eligible", async () => {
    const base = { archiveItemId: SNAKE, mediaType: "video" as const, role: "content" as const };
    await repo.saveMediaAssets([
      { ...base, id: `${SNAKE}:media:0` as MediaAssetId, position: 0, retrieval: { status: "unavailable", checkedAt: T_MEDIA, reason: "restricted", detail: "Embed page has no video URL" } },
      { ...base, id: `${SNAKE}:media:1` as MediaAssetId, position: 1, retrieval: { status: "failed", lastAttemptAt: T_MEDIA, attempts: 1, error: "unknown: boom" } },
    ]);
    assert.ok(!(await candidates()).includes(SNAKE));
    assert.equal((await serviceAt(T_REENRICHED).enrich(SNAKE)).status, "skipped");
    assert.equal(provider.requests.length, 0);
  });

  test("media stored after a metadata-only organization makes it eligible; re-enrichment appends a media-aware one", async () => {
    assert.deepEqual(await searchIds("ceramic"), []); // the metadata-only organization knows nothing about clay
    await storeVideo(T_MEDIA);
    const candidate = (await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES })).find((c) => c.itemId === SNAKE);
    assert.deepEqual([candidate?.hasStoredMedia, candidate?.latestOrganization], [true, { promptVersion: "organize-v1/metadata", createdAt: T_ORGANIZED }]);
    assert.ok((await candidates()).includes(SNAKE));

    const before = (await repo.getArchiveItemAggregate(SNAKE))?.aiSuggestions;
    const result = await serviceAt(T_REENRICHED).enrich(SNAKE);
    assert.ok(result.status === "enriched");
    assert.deepEqual([result.reenriched, result.mediaUsed, result.organization.promptVersion], [true, true, "organize-v1/media"]);
    assert.deepEqual(provider.requests[0]?.images.map((i) => new TextDecoder().decode(i.bytes)), ["snake frame"]);

    // Immutable history: the first organization is untouched; the new one is appended after it.
    const after = (await repo.getArchiveItemAggregate(SNAKE))?.aiSuggestions;
    assert.equal(after?.length, 2);
    assert.deepEqual(after?.[0], before?.[0]);
    assert.deepEqual(after?.[1]?.fields.tags, MEDIA_ANSWER.tags);

    // The newer, media-aware organization is the one search uses.
    assert.deepEqual(await searchIds("ceramic"), [SNAKE]);
    assert.deepEqual(await searchIds("clay sculpture"), [SNAKE]);
    assert.deepEqual(await searchIds("whimsical"), []); // only the old organization said that
  });

  test("after media-aware re-enrichment it is never redone, even when more media arrives", async () => {
    await storeVideo(T_MEDIA);
    await serviceAt(T_REENRICHED).enrich(SNAKE);
    await storeAsset({ id: `${SNAKE}:media:1` as MediaAssetId, archiveItemId: SNAKE, mediaType: "image", role: "content", position: 1 }, "image/jpeg", new Uint8Array([1]), { retrievedAt: "2026-10-04T00:00:00.000Z" });
    assert.ok(!(await candidates()).includes(SNAKE));
    const again = await serviceAt("2026-10-05T00:00:00.000Z").enrich(SNAKE);
    assert.deepEqual([again.status, again.status === "skipped" && again.reason], ["skipped", "already has a media-aware AI organization"]);
    assert.equal(provider.requests.length, 1);
  });

  test("a cover image stored later also makes a metadata-only organization eligible, and is what the AI sees", async () => {
    await storeAsset({ id: `${SNAKE}:cover` as MediaAssetId, archiveItemId: SNAKE, mediaType: "image", role: "cover" }, "image/jpeg", new TextEncoder().encode("snake cover"), { retrievedAt: T_MEDIA });
    assert.ok((await candidates()).includes(SNAKE));
    const result = await serviceAt(T_REENRICHED).enrich(SNAKE);
    assert.ok(result.status === "enriched");
    assert.deepEqual([result.reenriched, result.organization.promptVersion], [true, "organize-v1/media"]);
    assert.deepEqual(provider.requests[0]?.images.map((i) => new TextDecoder().decode(i.bytes)), ["snake cover"]);
    assert.ok(!(await candidates()).includes(SNAKE)); // not redone
  });

  test("a batch picks it up, and new media the AI cannot use never causes a metadata-only repeat", async () => {
    await storeVideo(T_MEDIA);
    const batch = await runEnrichmentBatch({ service: serviceAt(T_REENRICHED), repository: repo, ownerId: OWNER, limit: 1 });
    assert.deepEqual(batch.results.map((r) => [r.itemId, r.status]), [[SNAKE, "enriched"]]); // stored media: first in the sample

    // Separately: media the provider cannot take (here, an image type it does not accept).
    const OTHER = id("ReelAAA111");
    await serviceAt(T_ORGANIZED).enrich(OTHER); // metadata-only first
    await storeAsset({ id: `${OTHER}:media:0` as MediaAssetId, archiveItemId: OTHER, mediaType: "image", role: "content", position: 0 }, "image/heic", new Uint8Array([1]), { retrievedAt: T_MEDIA });
    const requests = provider.requests.length;
    const skipped = await serviceAt(T_REENRICHED).enrich(OTHER);
    assert.deepEqual([skipped.status, skipped.status === "skipped" && skipped.reason], ["skipped", "media stored since the last organization is not usable by the AI"]);
    assert.equal(provider.requests.length, requests);
    assert.equal((await repo.getArchiveItemAggregate(OTHER))?.aiSuggestions.length, 1);
  });
});

describe("enrichment priority: new captures before backfill", () => {
  const T1 = "2026-10-10T08:00:00.000Z"; // a later, incremental import
  const LATER_SOURCE = { exportLocation: { file: "later.json" }, raw: {}, importedAt: T1 };

  /** Simulates a later import: a new saved item, and new records on existing items. */
  async function laterImport() {
    await repo.saveArchiveItem({
      id: id("NewSaved9"), ownerId: OWNER, identity: { kind: "shortcode", shortcode: "NewSaved9" }, kind: "post",
      canonicalUrl: "https://www.instagram.com/p/NewSaved9/", createdAt: T1, updatedAt: T1,
    });
    await repo.saveArchiveItem({
      id: id("NewLiked10"), ownerId: OWNER, identity: { kind: "shortcode", shortcode: "NewLiked10" }, kind: "post",
      canonicalUrl: "https://www.instagram.com/p/NewLiked10/", createdAt: T1, updatedAt: T1,
    });
    await repo.addSourceRecords([
      { ...LATER_SOURCE, id: "later:new-saved" as SourceRecordId, archiveItemId: id("NewSaved9"), source: "saved", originalUrl: "https://www.instagram.com/p/NewSaved9/", occurredAt: "2026-10-09T00:00:00.000Z" },
      { ...LATER_SOURCE, id: "later:new-liked" as SourceRecordId, archiveItemId: id("NewLiked10"), source: "liked", originalUrl: "https://www.instagram.com/p/NewLiked10/", occurredAt: "2026-10-09T00:00:00.000Z" },
      // The liked-only PostCCC333 is now saved too: it enters the main archive as a new capture.
      { ...LATER_SOURCE, id: "later:post-saved" as SourceRecordId, archiveItemId: id("PostCCC333"), source: "saved", originalUrl: "https://www.instagram.com/p/PostCCC333/", occurredAt: "2026-10-08T00:00:00.000Z" },
      // ReelAAA111 only gets a new like: it stays backfill.
      { ...LATER_SOURCE, id: "later:reel-liked" as SourceRecordId, archiveItemId: id("ReelAAA111"), source: "liked", originalUrl: "https://www.instagram.com/reel/ReelAAA111/", occurredAt: "2026-10-09T00:00:00.000Z" },
    ]);
    await repo.saveOriginalMetadata(id("NewSaved9"), { caption: { value: "new embroidery find", provenance: { from: "export", sourceRecordId: "later:new-saved" as SourceRecordId } } });
    await repo.saveOriginalMetadata(id("NewLiked10"), { caption: { value: "liked only", provenance: { from: "export", sourceRecordId: "later:new-liked" as SourceRecordId } } });
  }
  const priorities = async () =>
    Object.fromEntries((await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES })).map((c) => [c.itemId.split(":").pop(), c.priority]));

  test("the first import is backfill; main-archive records imported later make an item new", async () => {
    assert.deepEqual(await priorities(), { ReelAAA111: "backfill", CarouBBB222: "backfill", BareDDD444: "backfill", ReplyEEE555: "backfill" });
    await laterImport();
    assert.deepEqual(await priorities(), {
      NewSaved9: "new", PostCCC333: "new", // newly saved
      ReelAAA111: "backfill", // only a new like: likes don't make an item a new capture
      CarouBBB222: "backfill", BareDDD444: "backfill", ReplyEEE555: "backfill", // historical items stay eligible
    }); // NewLiked10 is liked-only: not a candidate at all
  });

  test("a batch enriches new captures first (stored media first), then backfill; enriched items drop out", async () => {
    await laterImport();
    // PostCCC333 has stored media, so it comes before the newer, metadata-only NewSaved9.
    await storeAsset({ id: `${id("PostCCC333")}:media:0` as MediaAssetId, archiveItemId: id("PostCCC333"), mediaType: "image", role: "content", position: 0 }, "image/jpeg", new Uint8Array([1]));
    const first = await runEnrichmentBatch({ service: service(), repository: repo, ownerId: OWNER, limit: 2 });
    assert.deepEqual(first.results.map((r) => [r.itemId, r.status]), [[id("PostCCC333"), "enriched"], [id("NewSaved9"), "enriched"]]);
    assert.deepEqual(await priorities(), { ReelAAA111: "backfill", CarouBBB222: "backfill", BareDDD444: "backfill", ReplyEEE555: "backfill" });
    // With the new captures done, the next batch continues the backfill.
    const second = await runEnrichmentBatch({ service: service(), repository: repo, ownerId: OWNER, limit: 5 });
    assert.deepEqual(second.results.map((r) => r.itemId).sort(), [id("CarouBBB222"), id("ReelAAA111")]);
    const mainCandidates = await repo.listAiEnrichmentCandidates(OWNER, { sources: MAIN_ARCHIVE_SOURCES });
    assert.ok(!mainCandidates.some((c) => c.itemId === id("NewLiked10"))); // liked-only stays out, even when newly imported
    assert.equal(provider.requests.length, 4); // NewLiked10 (liked-only) was never sent
  });

  test("prioritizedSample: new items first (media, then newest), backfill fills the rest with the varied sample", () => {
    const c = (n: number, priority: "new" | "backfill", kind: "reel" | "carousel", sources: SourceKind[], creator: string, media = false, hasCaption = true) => ({
      itemId: `i${n}` as ArchiveItemId, kind, sources, creatorUsername: creator, hasCaption, hasStoredMedia: media, priority,
    });
    const candidates = [ // newest first
      c(1, "backfill", "reel", ["saved"], "ann"), c(2, "new", "reel", ["saved"], "bob"), c(3, "backfill", "reel", ["saved"], "ann"),
      c(4, "new", "carousel", ["messages"], "cat", true), c(5, "backfill", "carousel", ["messages"], "dan"),
      c(6, "new", "reel", ["messages"], "eve", false, false), // new but nothing to classify: never chosen
      c(7, "backfill", "reel", ["saved"], "fay", true), c(8, "backfill", "reel", ["saved"], "gus"),
    ];
    const backfill = candidates.filter((x) => x.priority === "backfill");
    // New: i4 (media) then i2; then backfill as representativeSample picks it (media i7 first, then varied).
    assert.deepEqual(prioritizedSample(candidates, 5), ["i4", "i2", ...representativeSample(backfill, 3)]);
    assert.deepEqual(prioritizedSample(candidates, 5).slice(2), ["i7", "i1", "i5"]);
    // A limit smaller than the new captures takes only new items.
    assert.deepEqual(prioritizedSample(candidates, 1), ["i4"]);
    // With no new captures, selection is exactly the existing varied backfill sample.
    assert.deepEqual(prioritizedSample(backfill, 4), representativeSample(backfill, 4));
    assert.ok(!prioritizedSample(candidates, 50).includes("i6" as ArchiveItemId));
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
    // Every classifiable fixture item in the main archive is now enriched. Never selected:
    // the two with neither caption nor media (BareDDD444, ReplyEEE555) and the liked-only
    // PostCCC333 (outside the main archive).
    const left = await runEnrichmentBatch({ service: service(), repository: repo, ownerId: OWNER, limit: 10 });
    assert.equal(left.attempted, 0);
    assert.equal(first.enriched + second.enriched, 2);
    assert.ok(![...first.results, ...second.results].some((r) => r.itemId === id("PostCCC333")));
    assert.equal(first.inputTokens + second.inputTokens, 100 * (first.enriched + second.enriched));
  });

  test("named items are processed in the given order, capped at the limit", async () => {
    const summary = await batch({ shortcodes: ["ReelAAA111", "CarouBBB222", "BareDDD444"] });
    assert.deepEqual(summary.results.map((r) => r.itemId), [id("ReelAAA111"), id("CarouBBB222")]);
    await assert.rejects(batch({ shortcodes: ["NoSuchPost"] }), /No archive item for shortcode NoSuchPost/);
    // A liked-only item is outside the main archive, even when named.
    await assert.rejects(batch({ shortcodes: ["PostCCC333"] }), /PostCCC333 is not in the main archive/);
    assert.equal(provider.requests.length, 2);
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
