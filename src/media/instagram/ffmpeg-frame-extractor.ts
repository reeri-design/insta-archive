/**
 * SPIKE (Step 08B.4): FrameExtractor using the locally installed ffmpeg and
 * ffprobe (no npm dependency). Frames are written as lossless PNG so no
 * compression choice is made yet.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { selectFrameIndices, type ExtractedFrame, type FrameExtractor } from "./reel-media.ts";

const run = promisify(execFile);
const MAX_OUTPUT = 64 * 1024 * 1024;

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

export class FfmpegFrameExtractor implements FrameExtractor {
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

/** Width/height from a PNG's IHDR header (bytes 16–23). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | Record<string, never> {
  if (bytes.length < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
