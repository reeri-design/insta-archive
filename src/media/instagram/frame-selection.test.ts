import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { frameDifference, isUselessFrame, MAX_DERIVED_FRAMES, selectRepresentativeFrames, type FrameCandidate } from "./frame-selection.ts";

const SIZE = 32 * 32;
/** A thumbnail: a horizontal gradient with a bright block at `scene` (0–7), so each scene looks clearly different. */
const scene = (n: number, jitter = 0) =>
  Uint8Array.from({ length: SIZE }, (_, i) => {
    const x = i % 32;
    const y = Math.floor(i / 32);
    const inBlock = Math.floor(x / 4) === n % 8 && y < 24;
    return Math.min(255, (inBlock ? 235 : 60 + x * 3) + ((i * 7 + jitter) % 3));
  });
const flat = (v: number) => new Uint8Array(SIZE).fill(v);
/** Black with a line of white text: a typical end card. */
const endCard = () => Uint8Array.from({ length: SIZE }, (_, i) => (Math.floor(i / 32) === 16 && i % 32 > 8 && i % 32 < 24 ? 250 : 4));
const at = (timeMs: number, pixels: Uint8Array): FrameCandidate => ({ timeMs, pixels });

describe("useless frames", () => {
  test("black, flat colours and text-on-black end cards are useless; real content is not", () => {
    assert.ok(isUselessFrame(flat(0)));
    assert.ok(isUselessFrame(flat(255)));
    assert.ok(isUselessFrame(flat(128)));
    assert.ok(isUselessFrame(endCard()));
    assert.ok(!isUselessFrame(scene(0)));
    assert.ok(!isUselessFrame(scene(5)));
  });
});

describe("frame difference", () => {
  test("is 0 for the same frame, small for jitter, large for another scene", () => {
    assert.equal(frameDifference(scene(1), scene(1)), 0);
    assert.ok(frameDifference(scene(1), scene(1, 1)) < 0.035);
    assert.ok(frameDifference(scene(1), scene(4)) > 0.1);
    assert.throws(() => frameDifference(scene(1), new Uint8Array(4)), /same/);
  });
});

describe("selecting representative frames", () => {
  test("keeps at most 8 frames, spanning the whole video, in time order", () => {
    // 60 candidates over 59 s, cycling through 8 scenes with small jitter.
    const candidates = Array.from({ length: 60 }, (_, k) => at(k * 1000, scene(Math.floor(k / 7.5), k)));
    const picked = selectRepresentativeFrames(candidates);
    assert.equal(picked.length, MAX_DERIVED_FRAMES);
    const times = picked.map((i) => candidates[i]!.timeMs);
    assert.equal(times[0], 0);
    assert.equal(times.at(-1), 59_000);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(new Set(times).size, times.length, "no repeated timestamp");
  });

  test("prefers scene changes: one frame per distinct scene, not evenly spaced copies", () => {
    // Four scenes of very different lengths; even spacing would mostly land in the long first one.
    const lengths = [40, 3, 3, 3];
    const candidates: FrameCandidate[] = [];
    let t = 0;
    lengths.forEach((len, s) => {
      for (let k = 0; k < len; k++) candidates.push(at((t++) * 500, scene(s, k)));
    });
    const picked = selectRepresentativeFrames(candidates);
    const scenes = new Set(picked.map((i) => Math.min(3, lengths.findIndex((_, s) => i < lengths.slice(0, s + 1).reduce((a, b) => a + b, 0)))));
    assert.deepEqual([...scenes].sort(), [0, 1, 2, 3], "every scene is represented");
    assert.equal(picked.length, 4, "near-duplicates within a scene are skipped");
  });

  test("skips near-duplicates: a static video yields one frame", () => {
    const candidates = Array.from({ length: 30 }, (_, k) => at(k * 1000, scene(2, k)));
    assert.deepEqual(selectRepresentativeFrames(candidates), [0]);
  });

  test("skips black frames and useless end cards, also at the start and the end", () => {
    const candidates = [at(0, flat(0)), at(1000, scene(1)), at(2000, scene(3)), at(3000, scene(6)), at(4000, endCard()), at(5000, flat(0))];
    assert.deepEqual(selectRepresentativeFrames(candidates), [1, 2, 3]);
  });

  test("handles fewer than 8 useful frames, and nothing useful at all", () => {
    assert.deepEqual(selectRepresentativeFrames([at(0, scene(0)), at(500, scene(4))]), [0, 1]);
    assert.deepEqual(selectRepresentativeFrames([at(0, flat(0)), at(500, endCard())]), []);
    assert.deepEqual(selectRepresentativeFrames([]), []);
  });

  test("never repeats a timestamp, even if the candidates do", () => {
    const candidates = [at(0, scene(0)), at(0, scene(5)), at(1000, scene(2))];
    const times = selectRepresentativeFrames(candidates).map((i) => candidates[i]!.timeMs);
    assert.equal(new Set(times).size, times.length);
  });

  test("respects a smaller maximum and is deterministic", () => {
    const candidates = Array.from({ length: 40 }, (_, k) => at(k * 250, scene(k % 8, k)));
    assert.equal(selectRepresentativeFrames(candidates, 3).length, 3);
    assert.deepEqual(selectRepresentativeFrames(candidates), selectRepresentativeFrames(candidates));
  });
});
