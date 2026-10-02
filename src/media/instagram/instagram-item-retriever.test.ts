import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, UserId } from "../../domain/archive-item.ts";
import { ingestInstagramExport } from "../../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { LocalMediaStorage } from "../local-media-storage.ts";
import { MediaRetrievalJob } from "../media-retrieval-job.ts";
import { embedUrlFor, type Fetch } from "./instagram-image-spike-adapter.ts";
import { InstagramItemRetriever } from "./instagram-item-retriever.ts";
import type { FrameExtractor } from "./reel-media.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const id = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;
const cdn = (name: string) => `https://cdn.example.test/${name}?oh=sig`;

// Synthetic embed pages in the three observed shapes.
const imagePage = () =>
  `<div class="Embed" data-media-type="GraphImage"></div><img class="EmbeddedMediaImage" srcset="${cdn("img.jpg")} 1080w" />`;
const blob = (media: unknown) => `<script>x({"contextJSON":${JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: media } }))}})</script>`;
const carouselPage = (slides: number) =>
  `<div class="Embed" data-media-type="GraphSidecar"></div>` +
  blob({ edge_sidecar_to_children: { edges: Array.from({ length: slides }, (_, i) => ({ node: { id: `${i}`, is_video: false, display_resources: [{ src: cdn(`slide${i}.jpg`), config_width: 1080, config_height: 1350 }] } })) } });
const reelPage = () =>
  `<div class="Embed" data-media-type="GraphVideo"></div>` +
  blob({ is_video: true, product_type: "clips", video_url: cdn("reel.mp4"), video_duration: 3, dimensions: { width: 720, height: 1280 } });

type Route = () => Response;
function stubFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route();
  };
  return Object.assign(fn, { calls });
}
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html" } });
const bytes = (type: string, label: string, status = 200) => () =>
  new Response(status === 200 ? new TextEncoder().encode(label) : "", { status, headers: { "content-type": type } });
const noFrames: FrameExtractor = { extract: async () => { throw new Error("not expected"); } };

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;
let clock: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-dispatch-"));
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
  clock = "2026-10-03T10:00:00.000Z";
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: clock });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const retrieverWith = (fetch: Fetch) =>
  new InstagramItemRetriever({
    repository: repo, storage: new LocalMediaStorage(join(dir, "media")), extractor: noFrames,
    maxRetainedVideoBytes: 20_000_000, fetch, tempRoot: dir, now: () => clock,
  });
const embedCalls = (fetch: { calls: string[] }) => fetch.calls.filter((u) => u.includes("/embed/")).length;

describe("InstagramItemRetriever routing", () => {
  test("a single image goes through the image adapter, fetching the page once", async () => {
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(imagePage()), [cdn("img.jpg")]: bytes("image/jpeg", "jpg") });
    const { request, mediaType } = await retrieverWith(fetch).retrieve(id("PostCCC333"));
    assert.equal(request.status, "stored");
    assert.equal(mediaType, "GraphImage");
    assert.equal(embedCalls(fetch), 1);
    assert.equal((await repo.getArchiveItem(id("PostCCC333")))?.kind, "post");
  });

  test("a Reel goes through the Reel strategy (small video kept)", async () => {
    const fetch = stubFetch({ [embedUrlFor("ReelAAA111")]: html(reelPage()), [cdn("reel.mp4")]: bytes("video/mp4", "mp4") });
    const { request, mediaType } = await retrieverWith(fetch).retrieve(id("ReelAAA111"));
    assert.equal(request.status, "stored");
    assert.equal(mediaType, "GraphVideo");
    assert.equal(embedCalls(fetch), 1);
    const media = (await repo.getArchiveItemAggregate(id("ReelAAA111")))?.media ?? [];
    assert.deepEqual(media.map((m) => [m.role, m.mediaType]), [["content", "video"]]);
  });

  test("a carousel retry downloads only the missing slides", async () => {
    let slide1 = bytes("image/jpeg", "", 500);
    const routes: Record<string, Route> = { [embedUrlFor("CarouBBB222")]: html(carouselPage(3)), [cdn("slide1.jpg")]: () => slide1() };
    for (const i of [0, 2]) routes[cdn(`slide${i}.jpg`)] = bytes("image/jpeg", `slide${i}`);
    const first = stubFetch(routes);
    const failed = await retrieverWith(first).retrieve(id("CarouBBB222"));
    assert.equal(failed.request.status, "failed");

    clock = failed.request.nextAttemptAt ?? clock;
    slide1 = bytes("image/jpeg", "slide1");
    const retry = stubFetch(routes);
    const stored = await retrieverWith(retry).retrieve(id("CarouBBB222"));
    assert.equal(stored.request.status, "stored");
    assert.deepEqual(retry.calls, [embedUrlFor("CarouBBB222"), cdn("slide1.jpg")]);
    const media = (await repo.getArchiveItemAggregate(id("CarouBBB222")))?.media ?? [];
    assert.deepEqual(media.map((m) => m.retrieval.status), ["stored", "stored", "stored"]);
  });

  test("failures map to the retrieval model, including rate limits on media downloads", async () => {
    const cases: [string, Record<string, Route>, string, string][] = [
      ["PostCCC333", { [embedUrlFor("PostCCC333")]: html("", 404) }, "unavailable", "not_found"],
      ["BareDDD444", { [embedUrlFor("BareDDD444")]: html("", 429) }, "failed", "rate_limited"],
      ["ReelAAA111", { [embedUrlFor("ReelAAA111")]: html(reelPage()), [cdn("reel.mp4")]: bytes("video/mp4", "", 429) }, "failed", "rate_limited"],
      ["CarouBBB222", { [embedUrlFor("CarouBBB222")]: html(carouselPage(1)), [cdn("slide0.jpg")]: bytes("image/jpeg", "", 429) }, "failed", "rate_limited"],
      ["ReplyEEE555", { [embedUrlFor("ReplyEEE555")]: html("<html>no embed</html>") }, "failed", "unknown"],
    ];
    for (const [shortcode, routes, status, code] of cases) {
      const { request } = await retrieverWith(stubFetch(routes)).retrieve(id(shortcode));
      assert.deepEqual([request.status, request.lastFailure?.code], [status, code], shortcode);
    }
    // The items themselves are untouched by failures.
    assert.equal((await repo.listArchiveItems(OWNER)).length, 5);
  });
});

describe("removed posts", () => {
  // Shape of the real page (HTTP 200): no media type, null data blob, this sentence.
  const removedPage = (shortcode: string) =>
    `<div class="EmbedHeader"></div><div class="EmbedBrokenMedia">Instagram The link to this photo or video may be broken, or the post may have been removed. ` +
    `<a class="EmbedVisitInstagram" href="https://www.instagram.com/p/${shortcode}/?utm_source=ig_embed&amp;utm_campaign=loading">Visit Instagram</a></div>` +
    `<script>x({"contextJSON":null})</script>`;

  test("Instagram's explicit 'may have been removed' page is unavailable, not retried", async () => {
    const before = await repo.getArchiveItemAggregate(id("PostCCC333"));
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(removedPage("PostCCC333")) });
    const { request } = await retrieverWith(fetch).retrieve(id("PostCCC333"));

    assert.equal(request.status, "unavailable");
    assert.deepEqual(request.lastFailure, {
      kind: "unavailable", code: "not_found", message: "Instagram says the post may have been removed or the link is broken",
    });
    assert.equal(request.nextAttemptAt, undefined);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(await repo.listDueMediaRetrievals("2030-01-01T00:00:00.000Z", 10, { ownerId: OWNER }).then((r) => r.some((x) => x.archiveItemId === id("PostCCC333"))), false);
    assert.deepEqual(await repo.getArchiveItemAggregate(id("PostCCC333")), before); // item intact
  });

  test("detection stays narrow: other HTTP 200 pages are not treated as removed", async () => {
    // No media type and no removal sentence → still a retryable failure.
    const generic = await retrieverWith(stubFetch({ [embedUrlFor("BareDDD444")]: html("<html>Something went wrong</html>") })).retrieve(id("BareDDD444"));
    assert.deepEqual([generic.request.status, generic.request.lastFailure?.code], ["failed", "unknown"]);

    // The sentence on a page that does have a media type (e.g. in a caption) → normal retrieval.
    const withMedia = imagePage() + "<p>the post may have been removed. The link to this photo or video may be broken, or the post may have been removed.</p>";
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(withMedia), [cdn("img.jpg")]: bytes("image/jpeg", "jpg") });
    const normal = await retrieverWith(fetch).retrieve(id("PostCCC333"));
    assert.equal(normal.request.status, "stored");
  });
});

test("job + Instagram retriever: a rate limit mid-batch stops the run", async () => {
  // Newest first: ReelAAA111, CarouBBB222, ReplyEEE555, PostCCC333, BareDDD444.
  const fetch = stubFetch({
    [embedUrlFor("ReelAAA111")]: html(reelPage()),
    [cdn("reel.mp4")]: bytes("video/mp4", "mp4"),
    [embedUrlFor("CarouBBB222")]: html("", 429),
  });
  const job = new MediaRetrievalJob({ repository: repo, retriever: retrieverWith(fetch), now: () => clock });
  const summary = await job.run({ ownerId: OWNER, limit: 10 });
  assert.deepEqual(summary.items.map((i) => [i.itemId, i.outcome]), [[id("ReelAAA111"), "stored"], [id("CarouBBB222"), "rate_limited"]]);
  assert.equal(summary.rateLimited, true);
  assert.equal(summary.remainingDue, 3);
  assert.ok(!fetch.calls.some((u) => u.includes("ReplyEEE555") || u.includes("PostCCC333")));
});
