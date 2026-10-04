import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { MediaSourceAdapter } from "../media-source-adapter.ts";
import { embedUrlFor, type Fetch } from "./instagram-image-spike-adapter.ts";
import { InstagramReelSpikeAdapter } from "./instagram-reel-spike-adapter.ts";
import {
  DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES,
  FRAME_INTERVAL_BUCKETS,
  frameIntervalForVideoBytes,
  ReelMediaRetrieval,
  reelMaxRetainedVideoBytesFromEnv,
  selectFrameIndices,
  type ExtractedFrame,
  type FrameExtractor,
} from "./reel-media.ts";

// ---------------------------------------------------------------------------
// Frame sampling
// ---------------------------------------------------------------------------

/** Frame timestamps (ms) of a constant-frame-rate video. */
const cfr = (fps: number, frameCount: number) => Array.from({ length: frameCount }, (_, i) => (i * 1000) / fps);
const pickedTimes = (times: number[], intervalMs: number) =>
  selectFrameIndices(times, intervalMs).map((i) => Math.round(times[i] ?? NaN));
const REAL_REEL = cfr(30, 369); // the 08B.3 Reel: 369 frames at 30 fps, 0–12,267 ms

describe("frame interval buckets", () => {
  test("each size bucket selects its interval; boundaries belong to the lower bucket", () => {
    const cases: [number, number][] = [
      [20_000_001, 4_000], // just over the default 20 MB retention threshold
      [50_000_000, 4_000],
      [50_000_001, 8_000],
      [100_000_000, 8_000],
      [100_000_001, 12_000],
      [2_000_000_000, 12_000],
      [1_000_000, 4_000], // a lower configured threshold still gets the base interval
    ];
    for (const [bytes, intervalMs] of cases) assert.equal(frameIntervalForVideoBytes(bytes), intervalMs, `${bytes} bytes`);
    assert.deepEqual(FRAME_INTERVAL_BUCKETS.map((b) => [b.overBytes, b.intervalMs]), [[100_000_000, 12_000], [50_000_000, 8_000], [0, 4_000]]);
  });
});

describe("frame sampling", () => {
  test("the real Reel's frames at each bucket interval", () => {
    assert.deepEqual(pickedTimes(REAL_REEL, 4_000), [0, 4000, 8000, 12000, 12267]);
    assert.deepEqual(pickedTimes(REAL_REEL, 8_000), [0, 8000, 12267]);
    assert.deepEqual(pickedTimes(REAL_REEL, 12_000), [0, 12000, 12267]);
  });

  test("frame count scales with duration (no fixed count)", () => {
    const counts = [1, 5, 12.3, 30, 61, 90].map((seconds) => selectFrameIndices(cfr(30, Math.round(seconds * 30)), 4_000).length);
    assert.deepEqual(counts, [2, 3, 5, 9, 17, 24]);
  });

  test("always starts with the first frame, also when the video does not start at 0", () => {
    for (const intervalMs of [4_000, 8_000, 12_000]) assert.equal(selectFrameIndices(REAL_REEL, intervalMs)[0], 0);
    assert.deepEqual(selectFrameIndices([500, 2500, 4600, 5000], 4_000), [0, 2, 3]); // marks at 500, 4500
  });

  test("adds the final frame only when the interval did not already pick it", () => {
    assert.deepEqual(pickedTimes(cfr(30, 121), 4_000), [0, 4000]); // last frame sits exactly on a mark
    assert.deepEqual(pickedTimes(cfr(30, 122), 4_000), [0, 4000, 4033]);
    assert.deepEqual(selectFrameIndices([0], 4_000), [0]);
    assert.deepEqual(selectFrameIndices([], 4_000), []);
    assert.throws(() => selectFrameIndices([0], 0), /must be positive/);
  });

  test("stays in chronological order with gaps of about the interval", () => {
    const times = cfr(30, 181 * 30);
    for (const intervalMs of [4_000, 8_000, 12_000]) {
      const picked = selectFrameIndices(times, intervalMs).map((i) => times[i] ?? NaN);
      for (let k = 1; k < picked.length; k++) assert.ok(picked[k]! > picked[k - 1]!, "strictly increasing");
      const gaps = picked.slice(1, -1).map((t, k) => t - picked[k]!);
      assert.ok(gaps.every((g) => Math.abs(g - intervalMs) <= 1000 / 30), `${intervalMs} ms gaps`);
    }
  });

  test("variable frame rate: takes the first frame at or after each mark", () => {
    assert.deepEqual(selectFrameIndices([0, 1900, 4100, 4500, 8300, 8310], 4_000), [0, 2, 4, 5]);
  });
});

describe("threshold configuration", () => {
  test("defaults when unset, reads the variable, and rejects nonsense", () => {
    assert.equal(reelMaxRetainedVideoBytesFromEnv({}), DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES);
    assert.equal(reelMaxRetainedVideoBytesFromEnv({ REEL_MAX_RETAINED_VIDEO_BYTES: "  " }), DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES);
    assert.equal(reelMaxRetainedVideoBytesFromEnv({ REEL_MAX_RETAINED_VIDEO_BYTES: "5000000" }), 5_000_000);
    assert.equal(reelMaxRetainedVideoBytesFromEnv({ REEL_MAX_RETAINED_VIDEO_BYTES: "0" }), 0);
    for (const bad of ["-1", "2.5", "10MB", "abc"]) {
      assert.throws(() => reelMaxRetainedVideoBytesFromEnv({ REEL_MAX_RETAINED_VIDEO_BYTES: bad }), /non-negative integer/);
    }
  });
});

// ---------------------------------------------------------------------------
// The strategy end to end, with a stub network and a fake extractor
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, "../../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const ITEM_ID = "owner-1:shortcode:ReelAAA111" as ArchiveItemId;
const EMBED = embedUrlFor("ReelAAA111");
const VIDEO_URL = "https://cdn.example.test/o1/reel.mp4?oh=sig";
const VIDEO_BYTES = new TextEncoder().encode("synthetic mp4 bytes, 37 bytes long!!");
const SIZE = VIDEO_BYTES.byteLength;

function reelEmbed(): string {
  const media = { __typename: "GraphVideo", is_video: true, product_type: "clips", video_url: VIDEO_URL, video_duration: 4.9, dimensions: { width: 720, height: 1280 } };
  const json = JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: media } }));
  return `<div class="Embed" data-media-type="GraphVideo"></div><script>x({"contextJSON":${json}})</script>`;
}

function stubFetch(routes: Record<string, () => Response>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route();
  };
  return Object.assign(fn, { calls });
}
const okRoutes = () => ({
  [EMBED]: () => new Response(reelEmbed(), { headers: { "content-type": "text/html" } }),
  [VIDEO_URL]: () => new Response(VIDEO_BYTES, { headers: { "content-type": "video/mp4" } }),
});

/** Writes one small file per timestamp; can be told to fail. */
class FakeExtractor implements FrameExtractor {
  calls = 0;
  sawVideo?: Uint8Array;
  sawIntervalMs?: number;
  private readonly timesMs: number[];
  private readonly error: Error | undefined;
  constructor(timesMs: number[], error?: Error) {
    this.timesMs = timesMs;
    this.error = error;
  }
  async extract(videoPath: string, outDir: string, intervalMs: number): Promise<ExtractedFrame[]> {
    this.calls++;
    this.sawIntervalMs = intervalMs;
    this.sawVideo = new Uint8Array(readFileSync(videoPath));
    if (this.error) throw this.error;
    mkdirSync(outDir, { recursive: true });
    // Returned out of order on purpose; frames must be stored chronologically.
    return [...this.timesMs].reverse().map((ms) => {
      const path = join(outDir, `frame_${ms}.png`);
      writeFileSync(path, `png frame ${ms}`);
      return { frameTimeMs: ms, path, mimeType: "image/png", width: 720, height: 1280 };
    });
  }
}

describe("Reel media strategy", () => {
  let dir: string;
  let tempRoot: string;
  let db: DatabaseSync;
  let repo: SqliteArchiveRepository;
  let storage: LocalMediaStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-reel-media-"));
    tempRoot = join(dir, "tmp");
    mkdirSync(tempRoot);
    db = openDatabase(join(dir, "test.sqlite"));
    repo = new SqliteArchiveRepository(db);
    storage = new LocalMediaStorage(join(dir, "media"));
    await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: "2026-10-02T00:00:00.000Z" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const strategy = (maxRetainedVideoBytes: number, fetch: Fetch, extractor: FrameExtractor) =>
    new ReelMediaRetrieval({
      repository: repo, storage, adapter: new InstagramReelSpikeAdapter(fetch), extractor, maxRetainedVideoBytes, tempRoot,
      now: () => "2026-10-02T12:00:00.000Z",
    });
  const storedFiles = () =>
    existsSync(join(dir, "media")) ? readdirSync(join(dir, "media"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  const media = async () => (await repo.getArchiveItemAggregate(ITEM_ID))?.media ?? [];

  describe("video withheld: cover image fallback", () => {
    const POSTER = "https://cdn.example.test/o1/cover.jpg?oh=sig";
    const COVER = new TextEncoder().encode("jpeg cover bytes");
    const withheldEmbed = (withCover: boolean) => {
      const media = {
        __typename: "GraphVideo", is_video: true, product_type: "clips", video_duration: 9.4, dimensions: { width: 720, height: 1280 },
        ...(withCover && { display_url: POSTER, display_resources: [{ src: POSTER, config_width: 720, config_height: 1280 }] }),
      };
      const json = JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: media } }));
      return `<div class="Embed" data-media-type="GraphVideo"></div><script>x({"contextJSON":${json}})</script>`;
    };
    const routes = (cover: () => Response, withCover = true) => ({
      [EMBED]: () => new Response(withheldEmbed(withCover), { headers: { "content-type": "text/html" } }),
      [POSTER]: cover,
    });
    const jpeg = () => new Response(COVER, { headers: { "content-type": "image/jpeg" } });

    test("the cover is stored as the Reel's cover, the video is recorded as unavailable, and nothing is extracted", async () => {
      const extractor = new FakeExtractor([0]);
      const fetch = stubFetch(routes(jpeg));
      const result = await strategy(SIZE, fetch, extractor).run(ITEM_ID);

      assert.deepEqual([result.representation, result.request.status, result.alreadyComplete], ["cover", "stored", false]);
      assert.equal(extractor.calls, 0);
      assert.deepEqual(fetch.calls, [EMBED, POSTER]);
      const assets = [...(await media())].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(assets.map((a) => [a.role, a.mediaType, a.retrieval.status]), [["cover", "image", "stored"], ["content", "video", "unavailable"]]);
      assert.deepEqual(assets[1]?.retrieval, { status: "unavailable", checkedAt: "2026-10-02T12:00:00.000Z", reason: "restricted", detail: "Embed page has no video URL" });
      assert.deepEqual(storedFiles().length, 1); // only the cover

      // Complete: a second run fetches nothing.
      const again = await strategy(SIZE, fetch, extractor).run(ITEM_ID);
      assert.deepEqual([again.alreadyComplete, again.representation], [true, "cover"]);
      assert.equal(fetch.calls.length, 2);
    });

    test("a failed cover download is retried; a stored cover is never downloaded again", async () => {
      const failing = await strategy(SIZE, stubFetch(routes(() => new Response("", { status: 500 }))), new FakeExtractor([0])).run(ITEM_ID);
      assert.equal(failing.request.status, "failed");
      assert.ok(failing.request.nextAttemptAt);
      assert.deepEqual((await media()).map((a) => [a.role, a.retrieval.status]), [["content", "unavailable"]]);

      const retried = await strategy(SIZE, stubFetch(routes(jpeg)), new FakeExtractor([0])).run(ITEM_ID);
      assert.deepEqual([retried.request.status, retried.representation], ["stored", "cover"]);

      // A manual retry re-runs the item (e.g. to check for the video again): the stored cover is kept, not re-fetched.
      await repo.saveMediaRetrievalRequest({ ...(await repo.getMediaRetrievalRequest(ITEM_ID))!, status: "pending" });
      const rerun = stubFetch(routes(() => { throw new Error("the cover must not be downloaded again"); }));
      const third = await strategy(SIZE, rerun, new FakeExtractor([0])).run(ITEM_ID);
      assert.deepEqual([third.request.status, third.representation], ["stored", "cover"]);
      assert.deepEqual(rerun.calls, [EMBED]);
      assert.equal((await media()).filter((a) => a.role === "cover" && a.retrieval.status === "stored").length, 1);
    });

    test("without a published cover, the Reel is unavailable as before and nothing is stored", async () => {
      const result = await strategy(SIZE, stubFetch(routes(jpeg, false)), new FakeExtractor([0])).run(ITEM_ID);
      assert.deepEqual([result.request.status, result.request.lastFailure?.code, result.representation], ["unavailable", "restricted", undefined]);
      assert.deepEqual(await media(), []);
    });
  });

  test("a video at or below the threshold is stored unchanged as the Reel's content video", async () => {
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    const extractor = new FakeExtractor([0]);
    const result = await strategy(SIZE, stubFetch(okRoutes()), extractor).run(ITEM_ID); // exactly at the threshold

    assert.equal(result.representation, "video");
    assert.equal(result.videoByteLength, SIZE);
    assert.equal(result.request.status, "stored");
    assert.equal(extractor.calls, 0);
    const assets = await media();
    assert.equal(assets.length, 1);
    const [video] = assets;
    assert.equal(video?.role === "content" && video.position, 0);
    assert.equal(video?.mediaType, "video");
    assert.ok(video?.retrieval.status === "stored");
    if (video?.retrieval.status !== "stored") return;
    assert.deepEqual(
      { ...video.retrieval, storageKey: "…" },
      { status: "stored", storageKey: "…", mimeType: "video/mp4", retrievedAt: "2026-10-02T12:00:00.000Z", byteLength: SIZE, width: 720, height: 1280, durationMs: 4900 },
    );
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, "media", video.retrieval.storageKey))), VIDEO_BYTES);
    assert.deepEqual(readdirSync(tempRoot), []); // no temp directory on this path
    assert.deepEqual((await repo.getArchiveItemAggregate(ITEM_ID))?.item, before?.item);
  });

  test("one byte over the threshold takes the frames path", async () => {
    const result = await strategy(SIZE - 1, stubFetch(okRoutes()), new FakeExtractor([0, 2000])).run(ITEM_ID);
    assert.equal(result.representation, "frames");
  });

  test("a larger video is stored as frames only; the video is discarded", async () => {
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    const extractor = new FakeExtractor([0, 2000, 4000, 4900]);
    const result = await strategy(10, stubFetch(okRoutes()), extractor).run(ITEM_ID);

    assert.equal(result.representation, "frames");
    assert.equal(result.request.status, "stored");
    assert.deepEqual(extractor.sawVideo, VIDEO_BYTES); // extraction used the downloaded video
    assert.equal(extractor.sawIntervalMs, 4_000); // base bucket
    const assets = await media();
    assert.deepEqual(assets.map((m) => m.role === "derived_frame" && m.frameTimeMs), [0, 2000, 4000, 4900]);
    for (const frame of assets) {
      assert.equal(frame.role, "derived_frame");
      assert.equal(frame.mediaType, "image");
      assert.equal("derivedFromAssetId" in frame, false);
      assert.ok(frame.retrieval.status === "stored");
      if (frame.retrieval.status !== "stored") continue;
      assert.equal(frame.retrieval.mimeType, "image/png");
      assert.equal(frame.retrieval.byteLength, readFileSync(join(dir, "media", frame.retrieval.storageKey)).byteLength);
      assert.deepEqual(frame.retrieval.derivedFrom, { mimeType: "video/mp4", byteLength: SIZE, width: 720, height: 1280, durationMs: 4900 });
    }
    // No video asset, no video file, no temp directory left.
    assert.ok(assets.every((m) => m.mediaType !== "video"));
    assert.ok(storedFiles().every((f) => f.endsWith(".png")));
    assert.equal(storedFiles().length, 4);
    assert.deepEqual(readdirSync(tempRoot), []);
    // The ArchiveItem (URL, kind, sources, metadata) is unchanged.
    assert.deepEqual((await repo.getArchiveItemAggregate(ITEM_ID))?.item, before?.item);
    assert.deepEqual((await repo.getArchiveItemAggregate(ITEM_ID))?.sources, before?.sources);
  });

  test("the frames path passes the size bucket's interval to the extractor", async () => {
    const big = new Uint8Array(50_000_001); // just into the 8 s bucket
    const adapter: MediaSourceAdapter = {
      name: "stand-in",
      canRetrieve: () => true,
      retrieve: async () => ({ ok: true, kind: "reel", assets: [{ position: 0, mediaType: "video", result: { ok: true, bytes: big, mimeType: "video/mp4" } }] }),
    };
    const extractor = new FakeExtractor([0, 8000]);
    const result = await new ReelMediaRetrieval({
      repository: repo, storage, adapter, extractor, maxRetainedVideoBytes: DEFAULT_REEL_MAX_RETAINED_VIDEO_BYTES, tempRoot,
    }).run(ITEM_ID);
    assert.equal(result.representation, "frames");
    assert.equal(extractor.sawIntervalMs, 8_000);
    assert.deepEqual(readdirSync(tempRoot), []);
    assert.ok((await media()).every((m) => m.role === "derived_frame"));
  });

  for (const [path, limit] of [["video", 1_000_000], ["frames", 0]] as const) {
    test(`a completed ${path} Reel is not fetched or processed again`, async () => {
      const fetch = stubFetch(okRoutes());
      const extractor = new FakeExtractor([0, 2000]);
      await strategy(limit, fetch, extractor).run(ITEM_ID);
      const assets = await media();
      const files = storedFiles().length;

      const again = await strategy(limit, fetch, extractor).run(ITEM_ID);
      assert.equal(again.alreadyComplete, true);
      assert.equal(again.representation, path);
      assert.equal(fetch.calls.length, 2);
      assert.equal(extractor.calls, path === "frames" ? 1 : 0);
      assert.deepEqual(await media(), assets);
      assert.equal(storedFiles().length, files);
    });
  }

  test("a failed extraction is not stored, and the temporary video is deleted", async () => {
    const extractor = new FakeExtractor([0], new Error("ffmpeg exited with code 1"));
    const result = await strategy(0, stubFetch(okRoutes()), extractor).run(ITEM_ID);

    assert.equal(result.request.status, "failed");
    assert.deepEqual(result.request.lastFailure, { kind: "temporary", code: "unknown", message: "Frame extraction failed: ffmpeg exited with code 1" });
    assert.equal(extractor.calls, 1);
    assert.deepEqual(await media(), []);
    assert.deepEqual(storedFiles(), []);
    assert.deepEqual(readdirSync(tempRoot), []);
  });

  test("a failed video download leaves the item intact on either path", async () => {
    const before = await repo.getArchiveItemAggregate(ITEM_ID);
    for (const limit of [1_000_000, 0]) {
      await repo.saveMediaRetrievalRequest({ archiveItemId: ITEM_ID, priority: 0, status: "pending", attempts: 0, createdAt: "x", updatedAt: "x" });
      const extractor = new FakeExtractor([0]);
      const fetch = stubFetch({ ...okRoutes(), [VIDEO_URL]: () => new Response("", { status: 403 }) });
      const result = await strategy(limit, fetch, extractor).run(ITEM_ID);
      assert.equal(result.request.status, "failed");
      assert.match(result.request.lastFailure?.message ?? "", /^Video download failed: HTTP 403/);
      assert.equal(extractor.calls, 0);
      assert.deepEqual(await repo.getArchiveItemAggregate(ITEM_ID), before);
      assert.deepEqual(readdirSync(tempRoot), []);
    }
  });
});
