import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, MediaAsset, UserId } from "../../domain/archive-item.ts";
import { ingestInstagramExport } from "../../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { LocalMediaStorage } from "../local-media-storage.ts";
import { MediaRetrievalService } from "../media-retrieval-service.ts";
import { InstagramCarouselSpikeAdapter, parseCarouselSlides } from "./instagram-carousel-spike-adapter.ts";
import { embedUrlFor, type Fetch } from "./instagram-image-spike-adapter.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const SHORTCODE = "CarouBBB222";
const ITEM_ID = `owner-1:shortcode:${SHORTCODE}` as ArchiveItemId;
const EMBED = embedUrlFor(SHORTCODE);

const slideUrl = (i: number, width: number) => `https://cdn.example.test/v/slide${i}_n.jpg?stp=w${width}&oh=sig${i}`;
const slideBytes = (i: number) => new TextEncoder().encode(`\xff\xd8 fake jpeg slide ${i}`);

/** Embed page in the observed carousel structure: GraphSidecar root + contextJSON string. */
function carouselHtml(count: number, options: { videoAt?: number; mediaType?: string; contextJSON?: "null" } = {}) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `90000000000000000${i}`,
    shortcode: `Child${i}`,
    is_video: i === options.videoAt,
    dimensions: { width: 1080, height: 1350 },
    // Renditions deliberately not sorted, as on the real page.
    display_resources: [
      { src: slideUrl(i, 640), config_width: 640, config_height: 800 },
      { src: slideUrl(i, 1080), config_width: 1080, config_height: 1350 },
      { src: slideUrl(i, 320), config_width: 320, config_height: 400 },
    ],
  }));
  const context = { context: {}, gql_data: { shortcode_media: { __typename: "GraphSidecar", edge_sidecar_to_children: { edges: nodes.map((node) => ({ node })) } } } };
  const json = options.contextJSON ?? JSON.stringify(JSON.stringify(context));
  return `<html><body><div class="Embed" data-media-type="${options.mediaType ?? "GraphSidecar"}"></div>
    <script>requireLazy([],function(){x({"contextJSON":${json}})});</script></body></html>`;
}

type Route = Response | Error;
function stubFetch(routes: Record<string, Route | (() => Route)>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const entry = routes[url];
    const route = typeof entry === "function" ? entry() : entry;
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    if (route instanceof Error) throw route;
    return route.clone();
  };
  return Object.assign(fn, { calls });
}
const page = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const jpeg = (i: number) => new Response(slideBytes(i), { status: 200, headers: { "content-type": "image/jpeg" } });

/** Embed page plus every slide's widest rendition. */
function carouselRoutes(count: number, html = carouselHtml(count)): Record<string, Route | (() => Route)> {
  const routes: Record<string, Route | (() => Route)> = { [EMBED]: page(html) };
  for (let i = 0; i < count; i++) routes[slideUrl(i, 1080)] = jpeg(i);
  return routes;
}

test("parseCarouselSlides reads slides in order with their widest rendition", () => {
  const slides = parseCarouselSlides(carouselHtml(3, { videoAt: 2 }));
  assert.deepEqual(slides?.map((s) => [s.id, s.isVideo, s.image?.width, s.image?.url]), [
    ["900000000000000000", false, 1080, slideUrl(0, 1080)],
    ["900000000000000001", false, 1080, slideUrl(1, 1080)],
    ["900000000000000002", true, 1080, slideUrl(2, 1080)],
  ]);
  assert.equal(parseCarouselSlides(carouselHtml(3, { contextJSON: "null" })), undefined);
});

describe("carousel spike through the retrieval service", () => {
  let dir: string;
  let db: DatabaseSync;
  let repo: SqliteArchiveRepository;
  let storage: LocalMediaStorage;
  let clock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-carousel-"));
    db = openDatabase(join(dir, "test.sqlite"));
    repo = new SqliteArchiveRepository(db);
    storage = new LocalMediaStorage(join(dir, "media"));
    clock = "2026-10-02T00:00:00.000Z";
    await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: clock });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const serviceWith = (fetch: Fetch) =>
    new MediaRetrievalService({ repository: repo, storage, adapters: [new InstagramCarouselSpikeAdapter(fetch)], now: () => clock });
  const media = async () => (await repo.getArchiveItemAggregate(ITEM_ID))?.media ?? [];
  const storedBytes = (asset: MediaAsset) =>
    asset.retrieval.status === "stored" ? new Uint8Array(readFileSync(join(dir, "media", asset.retrieval.storageKey))) : undefined;
  const fileCount = () => readdirSync(join(dir, "media"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;

  test("1–2. a carousel becomes one item with one ordered, stored MediaAsset per slide", async () => {
    const service = serviceWith(stubFetch(carouselRoutes(4)));
    await service.enqueue(ITEM_ID);
    const run = await service.process(ITEM_ID);
    assert.equal(run.request.status, "stored");
    assert.equal(run.storedAssets, 4);

    const assets = await media();
    assert.equal(assets.length, 4);
    assert.ok(assets.every((a) => a.archiveItemId === ITEM_ID && a.role === "content" && a.mediaType === "image"));
    assert.deepEqual(assets.map((a) => a.role === "content" && a.position), [0, 1, 2, 3]);
    assets.forEach((asset, i) => {
      assert.equal(asset.id, `${ITEM_ID}:media:${i}`);
      assert.deepEqual(storedBytes(asset), slideBytes(i)); // slide i is at position i
      assert.equal(asset.retrieval.status === "stored" && asset.retrieval.width, 1080);
      assert.equal(asset.retrieval.status === "stored" && asset.retrieval.height, 1350);
    });
    assert.equal(await repo.listArchiveItems(OWNER).then((items) => items.length), 5); // no items per slide
  });

  test("3. a non-carousel is rejected without downloading media", async () => {
    const fetch = stubFetch({ [EMBED]: page(carouselHtml(3, { mediaType: "GraphImage" })) });
    const service = serviceWith(fetch);
    await service.enqueue(ITEM_ID);
    const run = await service.process(ITEM_ID);
    assert.equal(run.request.status, "failed");
    assert.equal(run.request.lastFailure?.message, "Carousel spike only supports carousels; post is GraphImage");
    assert.deepEqual(fetch.calls, [EMBED]);
    assert.deepEqual(await media(), []);
  });

  test("4. a failed slide keeps the carousel retryable, never falsely stored", async () => {
    const routes = carouselRoutes(3);
    routes[slideUrl(1, 1080)] = new Response("", { status: 404 }); // e.g. an expired signed URL
    const first = await (async () => {
      const service = serviceWith(stubFetch(routes));
      await service.enqueue(ITEM_ID);
      return service.process(ITEM_ID);
    })();
    assert.equal(first.request.status, "failed");
    assert.equal(first.request.lastFailure?.kind, "temporary");
    assert.deepEqual((await media()).map((a) => a.retrieval.status), ["stored", "failed", "stored"]);

    // Retry: only the missing slide is downloaded.
    clock = first.request.nextAttemptAt ?? clock;
    const retryFetch = stubFetch(carouselRoutes(3));
    const second = await serviceWith(retryFetch).processNext();
    assert.equal(second?.request.status, "stored");
    assert.deepEqual(retryFetch.calls, [EMBED, slideUrl(1, 1080)]);
    const assets = await media();
    assert.deepEqual(assets.map((a) => a.retrieval.status), ["stored", "stored", "stored"]);
    assert.deepEqual(storedBytes(assets[1]!), slideBytes(1));
  });

  test("4b. a video slide or missing slide data is not reported as a stored carousel", async () => {
    const withVideo = serviceWith(stubFetch(carouselRoutes(3, carouselHtml(3, { videoAt: 1 }))));
    await withVideo.enqueue(ITEM_ID);
    assert.equal((await withVideo.process(ITEM_ID)).request.status, "failed");
    assert.equal((await media())[1]?.retrieval.status, "failed");

    await repo.saveMediaRetrievalRequest({ ...(await repo.getMediaRetrievalRequest(ITEM_ID))!, status: "pending" });
    const noData = serviceWith(stubFetch({ [EMBED]: page(carouselHtml(3, { contextJSON: "null" })) }));
    const run = await noData.process(ITEM_ID);
    assert.equal(run.request.status, "failed");
    assert.equal(run.request.lastFailure?.message, "Embed page has no carousel slide data");
  });

  test("5. re-running a stored carousel fetches nothing and duplicates nothing", async () => {
    const fetch = stubFetch(carouselRoutes(3));
    const service = serviceWith(fetch);
    await service.enqueue(ITEM_ID);
    await service.process(ITEM_ID);
    const before = { assets: await media(), files: fileCount(), calls: fetch.calls.length };

    assert.equal(await service.enqueue(ITEM_ID), false);
    const again = await service.process(ITEM_ID);
    assert.equal(again.alreadyStored, true);
    assert.equal(fetch.calls.length, before.calls);
    assert.deepEqual(await media(), before.assets);
    assert.equal(fileCount(), 3);
  });
});

test("the adapter itself skips positions that are already stored", async () => {
  const fetch = stubFetch(carouselRoutes(3));
  const item = { id: ITEM_ID, identity: { kind: "shortcode", shortcode: SHORTCODE } } as never;
  const outcome = await new InstagramCarouselSpikeAdapter(fetch).retrieve(item, { storedPositions: new Set([0, 2]) });
  assert.deepEqual(fetch.calls, [EMBED, slideUrl(1, 1080)]);
  assert.deepEqual(outcome.ok && outcome.assets.map((a) => a.result.ok), ["already_stored", true, "already_stored"]);
});
