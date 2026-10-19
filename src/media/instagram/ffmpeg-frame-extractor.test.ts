import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FfmpegFrameExtractor, ffmpegAvailable, jpegSize } from "./ffmpeg-frame-extractor.ts";

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

  describe("representative frames for a large Reel", () => {
    let scenes: string;
    let still: string;
    before(() => {
      // 3 s each of three different scenes, then 2 s of black (an empty end card): 11 s at 10 fps, 160×120.
      scenes = join(dir, "scenes.mp4");
      const part = (src: string) => ["-f", "lavfi", "-i", `${src}=size=160x120:rate=10:duration=3`];
      execFileSync("ffmpeg", [
        "-v", "error", ...part("testsrc"), ...part("smptebars"), ...part("rgbtestsrc"),
        "-f", "lavfi", "-i", "color=black:size=160x120:rate=10:duration=2",
        "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]", "-map", "[v]", "-pix_fmt", "yuv420p", scenes,
      ]);
      // 5 s of a still picture: nothing changes.
      still = join(dir, "still.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "smptebars=size=160x120:rate=10:duration=5", "-pix_fmt", "yuv420p", still]);
    });

    test("writes at most 8 full-size JPEGs across the video, one per scene, skipping the black ending", async () => {
      const frames = await new FfmpegFrameExtractor().representativeFrames(scenes, join(dir, "rep"), { maxFrames: 8 });
      assert.ok(frames.length >= 3 && frames.length <= 8, `${frames.length} frames`);
      const times = frames.map((f) => f.frameTimeMs);
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
      assert.equal(new Set(times).size, times.length, "no repeated timestamp");
      assert.ok(times[0]! < 1000, "starts near the beginning");
      assert.ok(times.some((t) => t >= 3000 && t < 6000) && times.some((t) => t >= 6000 && t < 9000), "covers every scene");
      assert.ok(times.every((t) => t < 9000), "no frame from the black ending");
      for (const frame of frames) {
        assert.equal(frame.mimeType, "image/jpeg");
        const bytes = readFileSync(frame.path);
        assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], "a JPEG file");
        assert.deepEqual(jpegSize(bytes), { width: 160, height: 120 });
        assert.deepEqual([frame.width, frame.height], [160, 120]);
      }
    });

    test("a still video yields a single frame, and the maximum is respected", async () => {
      assert.equal((await new FfmpegFrameExtractor().representativeFrames(still, join(dir, "still-frames"), { maxFrames: 8 })).length, 1);
      assert.ok((await new FfmpegFrameExtractor().representativeFrames(scenes, join(dir, "two"), { maxFrames: 2 })).length <= 2);
    });
  });

  test("fails on a file that is not a video", async () => {
    const bogus = join(dir, "not-a-video.mp4");
    writeFileSync(bogus, "definitely not a video");
    await assert.rejects(new FfmpegFrameExtractor().extract(bogus, join(dir, "bogus-frames"), 4_000));
  });
});
