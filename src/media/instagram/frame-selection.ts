/**
 * Which frames represent a Reel whose video is not kept (see reel-media.ts).
 *
 * Candidates are frames sampled across the whole video, each reduced to a
 * small grayscale thumbnail of the same size. Selection keeps at most
 * MAX_DERIVED_FRAMES of them:
 *
 *  - useless frames are skipped: black, nearly black (e.g. an end card with a
 *    line of text on black) or flat (one colour, white included);
 *  - the first and last useful frames are kept, so the selection spans the
 *    video;
 *  - the rest is chosen greedily for what is most different from everything
 *    already chosen (scene and content changes), with a smaller preference
 *    for time not yet covered;
 *  - near-duplicates of a chosen frame are never added, so a mostly static
 *    video yields fewer frames rather than eight copies.
 *
 * Pure: no I/O. Deterministic: same candidates, same selection.
 */

export const MAX_DERIVED_FRAMES = 8;

/** Mean absolute difference (0–1) below which two thumbnails count as the same frame. */
export const NEAR_DUPLICATE_BELOW = 0.035;

/** A frame is useless when at least this share of its pixels is dark, or is all one tone. */
const USELESS_SHARE = 0.92;
/** Gray level (0–255) at or below which a pixel counts as dark. */
const DARK_LEVEL = 28;
/** Pixels within this many gray levels of the frame's median count as the same tone. */
const FLAT_TOLERANCE = 10;
/** How much uncovered time counts next to visual difference when choosing the next frame. */
const COVERAGE_WEIGHT = 0.25;

export type FrameCandidate = {
  /** From the start of the video. */
  timeMs: number;
  /** Grayscale thumbnail, one byte per pixel; every candidate has the same size. */
  pixels: Uint8Array;
};

/** Black, nearly black or a single flat tone: nothing worth keeping. */
export function isUselessFrame(pixels: Uint8Array): boolean {
  const n = pixels.length;
  if (n === 0) return true;
  let dark = 0;
  const histogram = new Uint32Array(256);
  for (const p of pixels) {
    if (p <= DARK_LEVEL) dark++;
    histogram[p]!++;
  }
  if (dark / n >= USELESS_SHARE) return true;
  // The median tone, and how much of the frame sits close to it.
  let seen = 0;
  let median = 0;
  for (; median < 256; median++) {
    seen += histogram[median]!;
    if (seen * 2 >= n) break;
  }
  let near = 0;
  for (let v = Math.max(0, median - FLAT_TOLERANCE); v <= Math.min(255, median + FLAT_TOLERANCE); v++) near += histogram[v]!;
  return near / n >= USELESS_SHARE;
}

/** Mean absolute difference of two thumbnails, 0 (identical) to 1. */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new Error("Thumbnails must be the same, non-zero size");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (255 * a.length);
}

/**
 * Indexes (into `candidates`) of the frames to keep, in time order: at most
 * `max`, none useless, no two near-duplicates, no repeated timestamp.
 */
export function selectRepresentativeFrames(candidates: readonly FrameCandidate[], max = MAX_DERIVED_FRAMES): number[] {
  if (!(max >= 1)) return [];
  // Time order, one candidate per timestamp, useless frames left out.
  const seenTimes = new Set<number>();
  const useful = candidates
    .map((c, index) => ({ ...c, index }))
    .sort((a, b) => a.timeMs - b.timeMs || a.index - b.index)
    .filter((c) => !seenTimes.has(c.timeMs) && (seenTimes.add(c.timeMs), !isUselessFrame(c.pixels)));
  if (useful.length === 0) return [];

  const first = useful[0]!;
  const last = useful.at(-1)!;
  const span = Math.max(1, last.timeMs - first.timeMs);
  const chosen = [first];
  const distinct = (c: (typeof useful)[number]) => chosen.every((s) => frameDifference(c.pixels, s.pixels) >= NEAR_DUPLICATE_BELOW);
  if (chosen.length < max && last !== first && distinct(last)) chosen.push(last);

  while (chosen.length < max) {
    let best: (typeof useful)[number] | undefined;
    let bestScore = -1;
    for (const c of useful) {
      if (chosen.includes(c)) continue;
      let visual = Infinity;
      let gap = Infinity;
      for (const s of chosen) {
        visual = Math.min(visual, frameDifference(c.pixels, s.pixels));
        gap = Math.min(gap, Math.abs(c.timeMs - s.timeMs) / span);
      }
      if (visual < NEAR_DUPLICATE_BELOW) continue; // the same as something already kept
      const score = visual + COVERAGE_WEIGHT * gap;
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    if (!best) break; // nothing new left: fewer than `max` useful, distinct frames
    chosen.push(best);
  }
  return chosen.sort((a, b) => a.timeMs - b.timeMs).map((c) => c.index);
}
