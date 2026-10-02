import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ArchiveItem, ArchiveItemId, UserId } from "../../domain/archive-item.ts";
import { ingestInstagramExport } from "../../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../../ingestion/instagram/read-export-directory.ts";
import { openDatabase } from "../../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../../persistence/sqlite/sqlite-archive-repository.ts";
import { LocalMediaStorage } from "../local-media-storage.ts";
import { MediaRetrievalService } from "../media-retrieval-service.ts";
import { embedUrlFor, InstagramImageSpikeAdapter, largestRendition, parseMediaType, type Fetch } from "./instagram-image-spike-adapter.ts";

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const ITEM_ID = "owner-1:shortcode:PostCCC333" as ArchiveItemId;
const BIG = "https://cdn.example.test/v/img_n.jpg?stp=dst-jpg_e35_tt6&_nc_ht=x";
const SMALL = "https://cdn.example.test/v/img_n.jpg?stp=dst-jpg_e35_p640x640_tt6&_nc_ht=x";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** Minimal embed page in the observed structure (entities as Instagram writes them). */
function embedHtml(mediaType = "GraphImage", srcset = `${SMALL} 640w,${BIG} 1440w,${SMALL} 320w`): string {
  const escaped = srcset.replace(/&/g, "&amp;");
  return `<html><body><div class="Embed" data-media-type="${mediaType}" data-media-id="1">
    <img class="EmbeddedMediaImage" alt="Instagram post" src="${SMALL.replace(/&/g, "&amp;")}" srcset="${escaped}" />
    </div><script>{"contextJSON":null}</script></body></html>`;
}

type Route = Response | (() => Response) | Error;

/** Fetch stub: answers by URL, records every request. */
function stubFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    if (route instanceof Error) throw route;
    return typeof route === "function" ? route() : route.clone();
  };
  return Object.assign(fn, { calls });
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const jpeg = () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });

const item = (shortcode = "PostCCC333"): ArchiveItem => ({
  id: `owner-1:shortcode:${shortcode}` as ArchiveItemId,
  ownerId: OWNER,
  identity: { kind: "shortcode", shortcode },
  kind: "unknown",
  canonicalUrl: `https://www.instagram.com/p/${shortcode}/`,
  original: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const noneStored = { storedPositions: new Set<number>() };

describe("embed page parsing", () => {
  test("reads the media type and the widest srcset rendition, decoding &amp;", () => {
    assert.equal(parseMediaType(embedHtml()), "GraphImage");
    assert.equal(parseMediaType(embedHtml("GraphSidecar")), "GraphSidecar");
    assert.equal(parseMediaType("<html></html>"), undefined);
    assert.deepEqual(largestRendition(embedHtml()), { url: BIG, width: 1440 });
    assert.equal(largestRendition("<img class=\"EmbeddedMediaImage\" src=\"x\" />"), undefined);
  });
});

describe("InstagramImageSpikeAdapter", () => {
  test("a single-image post: fetches the embed page, then the widest image, bytes untouched", async () => {
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(embedHtml()), [BIG]: jpeg() });
    const outcome = await new InstagramImageSpikeAdapter(fetch).retrieve(item(), noneStored);
    assert.deepEqual(fetch.calls, [embedUrlFor("PostCCC333"), BIG]);
    assert.deepEqual(outcome, {
      ok: true,
      kind: "post",
      assets: [{ position: 0, mediaType: "image", result: { ok: true, bytes: JPEG, mimeType: "image/jpeg", width: 1440 } }],
    });
  });

  test("a carousel (or anything but GraphImage) is refused before downloading media", async () => {
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(embedHtml("GraphSidecar")) });
    const outcome = await new InstagramImageSpikeAdapter(fetch).retrieve(item(), noneStored);
    assert.deepEqual(fetch.calls, [embedUrlFor("PostCCC333")]);
    assert.deepEqual(outcome, {
      ok: false,
      failure: { kind: "temporary", code: "unknown", message: "Spike only supports single images; post is GraphSidecar" },
    });
  });

  test("HTTP and network failures map to the retrieval failure model", async () => {
    const cases: [Route, unknown][] = [
      [html("", 404), { kind: "unavailable", code: "not_found", message: "HTTP 404" }],
      [new Response("", { status: 429, headers: { "retry-after": "120" } }), { kind: "temporary", code: "rate_limited", message: "HTTP 429", retryAfterMs: 120_000 }],
      [html("Sorry", 500), { kind: "temporary", code: "server_error", message: "HTTP 500" }],
      [new Error("ECONNRESET"), { kind: "temporary", code: "network_error", message: "ECONNRESET" }],
      [html("<html>no embed markup</html>"), { kind: "temporary", code: "unknown", message: "Embed page has no media type (layout changed or post unavailable)" }],
    ];
    for (const [response, failure] of cases) {
      const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: response });
      assert.deepEqual(await new InstagramImageSpikeAdapter(fetch).retrieve(item(), noneStored), { ok: false, failure });
    }
  });

  test("a non-image download is a failure, not stored media", async () => {
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(embedHtml()), [BIG]: html("<html>login</html>") });
    const outcome = await new InstagramImageSpikeAdapter(fetch).retrieve(item(), noneStored);
    assert.deepEqual(outcome, { ok: false, failure: { kind: "temporary", code: "unknown", message: 'Expected an image, got "text/html"' } });
  });

  test("an already-stored image is not fetched again", async () => {
    const fetch = stubFetch({});
    const outcome = await new InstagramImageSpikeAdapter(fetch).retrieve(item(), { storedPositions: new Set([0]) });
    assert.deepEqual(fetch.calls, []);
    assert.equal(outcome.ok && outcome.assets[0]?.result.ok, "already_stored");
  });
});

describe("spike through the retrieval service", () => {
  let dir: string;
  let db: DatabaseSync;
  let repo: SqliteArchiveRepository;
  let storage: LocalMediaStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-spike-"));
    db = openDatabase(join(dir, "test.sqlite"));
    repo = new SqliteArchiveRepository(db);
    storage = new LocalMediaStorage(join(dir, "media"));
    await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: "2026-10-01T00:00:00.000Z" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const serviceWith = (fetch: Fetch) =>
    new MediaRetrievalService({
      repository: repo, storage, adapters: [new InstagramImageSpikeAdapter(fetch)], now: () => "2026-10-02T00:00:00.000Z",
    });

  test("stores the image file, persists a stored MediaAsset, and is idempotent", async () => {
    const fetch = stubFetch({ [embedUrlFor("PostCCC333")]: html(embedHtml()), [BIG]: jpeg() });
    const service = serviceWith(fetch);
    await service.enqueue(ITEM_ID);
    const run = await service.process(ITEM_ID);
    assert.equal(run.request.status, "stored");

    const aggregate = await repo.getArchiveItemAggregate(ITEM_ID);
    assert.equal(aggregate?.item.kind, "post");
    assert.equal(aggregate?.media.length, 1);
    const [asset] = aggregate?.media ?? [];
    assert.equal(asset?.retrieval.status, "stored");
    if (asset?.retrieval.status !== "stored") return;
    assert.deepEqual(asset.retrieval.mimeType, "image/jpeg");
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, "media", asset.retrieval.storageKey))), JPEG);

    // Running again: no request, no duplicate asset or file.
    await service.enqueue(ITEM_ID);
    const again = await service.process(ITEM_ID);
    assert.equal(again.alreadyStored, true);
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual((await repo.getArchiveItemAggregate(ITEM_ID))?.media, aggregate?.media);
  });

  test("a failed retrieval keeps the ArchiveItem intact", async () => {
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    const service = serviceWith(stubFetch({ [embedUrlFor("PostCCC333")]: html("", 404) }));
    await service.enqueue(ITEM_ID);
    const run = await service.process(ITEM_ID);
    assert.equal(run.request.status, "unavailable");
    assert.deepEqual(await repo.getArchiveItemAggregate(ITEM_ID), before);
  });
});
