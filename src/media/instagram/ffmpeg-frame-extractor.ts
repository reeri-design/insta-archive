/**
 * Frame extraction with the locally installed ffmpeg and ffprobe (no npm
 * dependency):
 *  - representativeFrames: a large Reel's stored frames. The whole video is
 *    sampled as tiny grayscale thumbnails in one pass, up to 8 frames are
 *    chosen from them (frame-selection.ts), and only those are written, at
 *    full size, as JPEG.
 *  - representativeFromImages: the same choice among already stored frames
 *    (migrating Reels stored under the earlier strategy), written as JPEG.
 *  - extract: frames every `intervalMs`, as PNG (used by AI enrichment for a
 *    stored video, in a temporary folder; never stored).
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { selectRepresentativeFrames, type FrameCandidate } from "./frame-selection.ts";
import type { StoredFrameReencoder } from "./reel-frame-migration.ts";
import { selectFrameIndices, type ExtractedFrame, type FrameExtractor, type ReelFrameExtractor } from "./reel-media.ts";

const run = promisify(execFile);
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Candidate thumbnails are THUMB × THUMB grayscale pixels. */
const THUMB = 32;
/** About this many candidates across the video, never closer together than MIN_CANDIDATE_STEP_MS. */
const MAX_CANDIDATES = 160;
const MIN_CANDIDATE_STEP_MS = 250;
/** ffmpeg's JPEG quality scale (2 = best, 31 = worst): visually close to the source at a fraction of PNG's size. */
const JPEG_QUALITY = "3";

/** Whether ffmpeg and ffprobe can be executed. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export class FfmpegFrameExtractor implements FrameExtractor, ReelFrameExtractor, StoredFrameReencoder {
  async representativeFromImages(images: { path: string; timeMs: number }[], outDir: string, options: { maxFrames: number }): Promise<ExtractedFrame[]> {
    const candidates: FrameCandidate[] = [];
    for (const image of images) {
      const { stdout } = await run(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-v", "error", "-i", image.path, "-vf", `scale=${THUMB}:${THUMB}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
        { encoding: "buffer", maxBuffer: MAX_OUTPUT },
      );
      if (stdout.byteLength < THUMB * THUMB) throw new Error(`Could not read ${image.path}`);
      candidates.push({ timeMs: image.timeMs, pixels: new Uint8Array(stdout.buffer, stdout.byteOffset, THUMB * THUMB) });
    }
    await mkdir(outDir, { recursive: true });
    const frames: ExtractedFrame[] = [];
    for (const [k, index] of selectRepresentativeFrames(candidates, options.maxFrames).entries()) {
      const image = images[index]!;
      const path = join(outDir, `frame_${String(k).padStart(2, "0")}.jpg`);
      await run("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", image.path, "-q:v", JPEG_QUALITY, "-update", "1", "-y", path], { maxBuffer: MAX_OUTPUT });
      frames.push({ frameTimeMs: image.timeMs, path, mimeType: "image/jpeg", ...jpegSize(await readFile(path)) });
    }
    return frames;
  }

  async representativeFrames(videoPath: string, outDir: string, options: { maxFrames: number }): Promise<ExtractedFrame[]> {
    // 1. How long the video is, to spread the candidates across all of it.
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]);
    const durationMs = Number.parseFloat(probe.stdout) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("The video has no duration");
    const stepMs = Math.max(MIN_CANDIDATE_STEP_MS, Math.ceil(durationMs / MAX_CANDIDATES));

    // 2. One decoding pass: a tiny grayscale thumbnail every stepMs; showinfo logs each one's timestamp.
    const sampled = await run(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-v", "info", "-i", videoPath, "-map", "0:v:0",
        "-vf", `fps=${1000 / stepMs},scale=${THUMB}:${THUMB}:flags=area,format=gray,showinfo`,
        "-f", "rawvideo", "pipe:1"],
      { encoding: "buffer", maxBuffer: MAX_OUTPUT },
    );
    const ptsTimes = [...sampled.stderr.toString().matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const raw = sampled.stdout;
    const count = Math.min(ptsTimes.length, Math.floor(raw.byteLength / (THUMB * THUMB)));
    if (count === 0) throw new Error("The video has no decodable frames");
    const startSec = ptsTimes[0] ?? 0;
    const candidates: FrameCandidate[] = Array.from({ length: count }, (_, i) => ({
      timeMs: Math.round(((ptsTimes[i] ?? 0) - startSec) * 1000),
      pixels: new Uint8Array(raw.buffer, raw.byteOffset + i * THUMB * THUMB, THUMB * THUMB),
    }));

    // 3. Choose, then write only the chosen frames, full size, as JPEG.
    const picked = selectRepresentativeFrames(candidates, options.maxFrames);
    if (picked.length === 0) throw new Error("The video has no useful frames (black or empty throughout)");
    await mkdir(outDir, { recursive: true });
    const frames: ExtractedFrame[] = [];
    for (const [k, index] of picked.entries()) {
      const { timeMs } = candidates[index]!;
      const path = join(outDir, `frame_${String(k).padStart(2, "0")}.jpg`);
      await run(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-v", "error", "-ss", ((startSec * 1000 + timeMs) / 1000).toFixed(3), "-i", videoPath,
          "-map", "0:v:0", "-frames:v", "1", "-q:v", JPEG_QUALITY, "-update", "1", "-y", path],
        { maxBuffer: MAX_OUTPUT },
      );
      frames.push({ frameTimeMs: timeMs, path, mimeType: "image/jpeg", ...jpegSize(await readFile(path)) });
    }
    return frames;
  }

  async extract(videoPath: string, outDir: string, intervalMs: number): Promise<ExtractedFrame[]> {
    // 1. Every decoded frame's timestamp, in presentation order.
    const probe = await run(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", videoPath],
      { maxBuffer: MAX_OUTPUT },
    );
    const timesMs = probe.stdout
      .split("\n")
      .map((line) => Number.parseFloat(line.replace(/,$/, "")))
      .filter((t) => Number.isFinite(t))
      .map((t) => t * 1000);
    const indices = selectFrameIndices(timesMs, intervalMs);
    if (indices.length === 0) throw new Error("The video has no decodable frames");

    // 2. Decode once, keep the chosen frames; showinfo logs each kept
    //    frame's real timestamp.
    await mkdir(outDir, { recursive: true });
    const select = indices.map((n) => `eq(n\\,${n})`).join("+");
    const { stderr } = await run(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-v", "info", "-i", videoPath, "-map", "0:v:0",
        "-vf", `select='${select}',showinfo`, "-fps_mode", "vfr", "-start_number", "0",
        join(outDir, "frame_%05d.png")],
      { maxBuffer: MAX_OUTPUT },
    );
    const ptsTimes = [...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const files = (await readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length !== indices.length || ptsTimes.length !== indices.length) {
      throw new Error(`Expected ${indices.length} frames, got ${files.length} files and ${ptsTimes.length} timestamps`);
    }

    const startMs = timesMs[0] ?? 0;
    return Promise.all(
      files.map(async (file, i) => {
        const path = join(outDir, file);
        const size = pngSize(await readFile(path));
        return {
          frameTimeMs: Math.round((ptsTimes[i] ?? 0) * 1000 - startMs),
          path,
          mimeType: "image/png",
          ...size,
        };
      }),
    );
  }
}

/** Width/height from a JPEG's first start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | Record<string, never> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return {};
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return {};
    const marker = bytes[i + 1]!;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    i += 2 + view.getUint16(i + 2);
  }
  return {};
}

/** Width/height from a PNG's IHDR header (bytes 16–23). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | Record<string, never> {
  if (bytes.length < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
