import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FfmpegFrameExtractor, ffmpegAvailable } from "./ffmpeg-frame-extractor.ts";

// Uses the local ffmpeg on a synthetic clip; skipped where ffmpeg is missing.
const available = await ffmpegAvailable();

describe("FfmpegFrameExtractor", { skip: available ? false : "ffmpeg/ffprobe not installed" }, () => {
  let dir: string;
  let video: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "insta-archive-ffmpeg-"));
    video = join(dir, "clip.mp4");
    // 5 s test pattern at 10 fps, 64×48: frames at 0, 100, …, 4900 ms.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=5:size=64x48:rate=10", "-pix_fmt", "yuv420p", video]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("extracts the sampled frames as PNGs with their real timestamps and size", async () => {
    const sparse = await new FfmpegFrameExtractor().extract(video, join(dir, "frames-4s"), 4_000);
    assert.deepEqual(sparse.map((f) => f.frameTimeMs), [0, 4000, 4900]);
    const frames = await new FfmpegFrameExtractor().extract(video, join(dir, "frames"), 2_000);
    assert.deepEqual(frames.map((f) => f.frameTimeMs), [0, 2000, 4000, 4900]);
    for (const frame of frames) {
      assert.equal(frame.mimeType, "image/png");
      assert.deepEqual([frame.width, frame.height], [64, 48]);
      assert.deepEqual([...readFileSync(frame.path).subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
    }
  });

  test("fails on a file that is not a video", async () => {
    const bogus = join(dir, "not-a-video.mp4");
    writeFileSync(bogus, "definitely not a video");
    await assert.rejects(new FfmpegFrameExtractor().extract(bogus, join(dir, "bogus-frames"), 4_000));
  });
});
