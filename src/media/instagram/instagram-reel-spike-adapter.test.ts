import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItemId, UserId } from "../../domain/archive-item.ts";
import { ingestInstagramExport } from "../../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { isDue } from "../../domain/media-retrieval.ts";
import { LocalMediaStorage } from "../local-media-storage.ts";
import { MediaRetrievalService } from "../media-retrieval-service.ts";
import { embedUrlFor, type Fetch } from "./instagram-image-spike-adapter.ts";
import { InstagramReelSpikeAdapter, parseReelVideo } from "./instagram-reel-spike-adapter.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const SHORTCODE = "ReelAAA111";
const ITEM_ID = `owner-1:shortcode:${SHORTCODE}` as ArchiveItemId;
const EMBED = embedUrlFor(SHORTCODE);
const VIDEO_URL = "https://cdn.example.test/o1/v/t2/reel_video.mp4?_nc_ht=x&oh=sig&oe=EXPIRY";
// "ftyp" box start of an MP4; synthetic, not a real video.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);

/** Embed page in the observed Reel structure: GraphVideo root + contextJSON string. */
function reelHtml(options: { mediaType?: string; media?: Record<string, unknown> | null } = {}) {
  const media = options.media === undefined
    ? {
        __typename: "GraphVideo", is_video: true, product_type: "clips", video_url: VIDEO_URL,
        video_duration: 12.3, dimensions: { width: 720, height: 1280 }, display_url: "https://cdn.example.test/poster.jpg",
      }
    : options.media;
  const json = JSON.stringify(JSON.stringify({ context: {}, gql_data: { shortcode_media: media } }));
  return `<html><body><div class="Embed" data-media-type="${options.mediaType ?? "GraphVideo"}"></div>
    <img class="EmbeddedMediaImage" src="https://cdn.example.test/poster.jpg" />
    <script>x({"contextJSON":${json}})</script></body></html>`;
}

type Route = Response | Error;
function stubFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    if (route instanceof Error) throw route;
    return route.clone();
  };
  return Object.assign(fn, { calls });
}
const page = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const mp4 = () => new Response(MP4, { status: 200, headers: { "content-type": "video/mp4" } });

test("parseReelVideo reads the video URL and stated metadata", () => {
  assert.deepEqual(parseReelVideo(reelHtml()), {
    url: VIDEO_URL, isReel: true, durationMs: 12300, width: 720, height: 1280,
  });
  assert.equal(parseReelVideo(reelHtml({ media: null })), undefined);
  assert.equal(parseReelVideo(reelHtml({ media: { is_video: false, display_url: "x" } })), undefined);
});

describe("Reel spike through the retrieval service", () => {
  let dir: string;
  let db: DatabaseSync;
  let repo: SqliteArchiveRepository;
  let clock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-reel-"));
    db = openDatabase(join(dir, "test.sqlite"));
    repo = new SqliteArchiveRepository(db);
    clock = "2026-10-02T00:00:00.000Z";
    await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: clock });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const serviceWith = (fetch: Fetch) =>
    new MediaRetrievalService({
      repository: repo,
      storage: new LocalMediaStorage(join(dir, "media")),
      adapters: [new InstagramReelSpikeAdapter(fetch)],
      now: () => clock,
    });
  const run = async (fetch: Fetch) => {
    const service = serviceWith(fetch);
    await service.enqueue(ITEM_ID);
    return service.process(ITEM_ID);
  };
  const media = async () => (await repo.getArchiveItemAggregate(ITEM_ID))?.media ?? [];

  test("1. a Reel produces one stored video MediaAsset with its stated metadata", async () => {
    const result = await run(stubFetch({ [EMBED]: page(reelHtml()), [VIDEO_URL]: mp4() }));
    assert.equal(result.request.status, "stored");

    const assets = await media();
    assert.equal(assets.length, 1);
    const [video] = assets;
    assert.deepEqual(video, {
      id: `${ITEM_ID}:media:0`,
      archiveItemId: ITEM_ID,
      mediaType: "video",
      role: "content",
      position: 0,
      retrieval: {
        status: "stored",
        storageKey: video?.retrieval.status === "stored" ? video.retrieval.storageKey : "",
        mimeType: "video/mp4",
        retrievedAt: clock,
        width: 720,
        height: 1280,
        durationMs: 12300,
      },
    });
    assert.match(video?.retrieval.status === "stored" ? video.retrieval.storageKey : "", /\.mp4$/);
    assert.deepEqual(
      new Uint8Array(readFileSync(join(dir, "media", video?.retrieval.status === "stored" ? video.retrieval.storageKey : ""))),
      MP4,
    );
    assert.equal((await repo.getArchiveItem(ITEM_ID))?.kind, "reel");
  });

  test("2. non-video media is rejected by the Reel path without downloading", async () => {
    for (const [html, message] of [
      [reelHtml({ mediaType: "GraphImage" }), "Reel spike only supports videos; post is GraphImage"],
      [reelHtml({ mediaType: "GraphSidecar" }), "Reel spike only supports videos; post is GraphSidecar"],
    ] as const) {
      await repo.saveMediaRetrievalRequest({
        archiveItemId: ITEM_ID, priority: 0, status: "pending", attempts: 0, createdAt: clock, updatedAt: clock,
      });
      const fetch = stubFetch({ [EMBED]: page(html) });
      const result = await run(fetch);
      assert.equal(result.request.status, "failed");
      assert.equal(result.request.lastFailure?.message, message);
      assert.deepEqual(fetch.calls, [EMBED]);
    }
    // A video URL that serves something else is not stored as a video.
    const wrongType = stubFetch({ [EMBED]: page(reelHtml()), [VIDEO_URL]: new Response("<html/>", { headers: { "content-type": "text/html" } }) });
    await repo.saveMediaRetrievalRequest({ archiveItemId: ITEM_ID, priority: 0, status: "pending", attempts: 0, createdAt: clock, updatedAt: clock });
    assert.equal((await run(wrongType)).request.lastFailure?.message, 'Expected a video, got "text/html"');
    assert.deepEqual(await media(), []);
  });

  test("2b. a Reel whose embed withholds the video URL is unavailable: kept intact, never retried automatically", async () => {
    // As seen on real Reels: the embed describes the video (and a display image) but gives no video_url.
    const withheld = reelHtml({
      media: {
        __typename: "GraphVideo", is_video: true, product_type: "clips", video_duration: 12.3,
        dimensions: { width: 720, height: 1280 }, display_url: "https://cdn.example.test/poster.jpg",
      },
    });
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    const fetch = stubFetch({ [EMBED]: page(withheld) });
    const result = await run(fetch);

    assert.deepEqual(
      [result.request.status, result.request.attempts, result.request.nextAttemptAt, result.request.lastFailure],
      ["unavailable", 1, undefined, { kind: "unavailable", code: "restricted", message: "Embed page has no video URL" }],
    );
    assert.deepEqual(fetch.calls, [EMBED]); // nothing else is fetched
    assert.deepEqual(await media(), []);
    // The item, its metadata and its sources are exactly as they were.
    const after = await repo.getArchiveItemAggregate(ITEM_ID);
    assert.deepEqual([after?.item, after?.sources], [before?.item, before?.sources]);
    // Never due again on its own, however much later...
    const muchLater = "2027-01-01T00:00:00.000Z";
    assert.equal(isDue(result.request, muchLater), false);
    assert.ok(!(await repo.listDueMediaRetrievals(muchLater)).some((r) => r.archiveItemId === ITEM_ID));
    // ...but a manual retry still re-runs it.
    const retried = await serviceWith(fetch).retryManually(ITEM_ID);
    assert.equal(isDue(retried, clock), true);
  });

  test("3. a failed video download keeps the item intact and is retryable", async () => {
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    for (const failure of [new Response("", { status: 403 }), new Error("socket hang up")]) {
      await repo.saveMediaRetrievalRequest({ archiveItemId: ITEM_ID, priority: 0, status: "pending", attempts: 0, createdAt: clock, updatedAt: clock });
      const result = await run(stubFetch({ [EMBED]: page(reelHtml()), [VIDEO_URL]: failure }));
      assert.equal(result.request.status, "failed");
      assert.equal(result.request.lastFailure?.kind, "temporary");
      assert.match(result.request.lastFailure?.message ?? "", /^Video download failed: /);
      assert.ok(result.request.nextAttemptAt); // scheduled for an automatic retry
      assert.deepEqual(await repo.getArchiveItemAggregate(ITEM_ID), before);
    }
  });

  test("4. a second run after storage downloads nothing and adds nothing", async () => {
    const fetch = stubFetch({ [EMBED]: page(reelHtml()), [VIDEO_URL]: mp4() });
    await run(fetch);
    const assets = await media();
    const files = readdirSync(join(dir, "media"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;

    const again = await run(fetch);
    assert.equal(again.alreadyStored, true);
    assert.deepEqual(fetch.calls, [EMBED, VIDEO_URL]);
    assert.deepEqual(await media(), assets);
    assert.equal(readdirSync(join(dir, "media"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length, files);
  });
});
