import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resultsLayout } from "./results-layout.ts";

describe("resultsLayout", () => {
  const options = { columns: 3, columnWidth: 100, gap: 10 };

  it("places the first row in ranked order, left to right", () => {
    const { rects } = resultsLayout([1, 1, 1], options);
    assert.deepEqual(rects.map((r) => [r.x, r.y]), [[0, 0], [110, 0], [220, 0]]);
  });

  it("puts each next item in the shortest column, leftmost on a tie", () => {
    const { rects } = resultsLayout([2, 1, 1.5, 1, 1], options);
    // Bottoms after the first row: 210, 110, 160 → item 3 goes under item 1, then item 4 under item 2.
    assert.deepEqual(rects.slice(3).map((r) => [r.x, r.y]), [[110, 110], [220, 160]]);
  });

  it("lays out every item exactly once, with its own proportions", () => {
    const ratios = [1.25, 0.7, 1.8, 0.55, 1, 1.3, 0.45];
    const { rects } = resultsLayout(ratios, options);
    assert.equal(rects.length, ratios.length);
    assert.deepEqual(rects.map((r) => r.height), ratios.map((ratio) => Math.round(100 * ratio)));
    // No two items overlap.
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        assert.ok(apart, `items overlap: ${JSON.stringify([a, b])}`);
      }
    }
  });

  it("is prefix-stable: more items never move earlier ones", () => {
    const ratios = [1, 1.5, 0.7, 1.2, 0.9, 1.6, 1.1];
    const short = resultsLayout(ratios.slice(0, 4), options);
    const long = resultsLayout(ratios, options);
    assert.deepEqual(long.rects.slice(0, 4), short.rects);
    assert.equal(long.heightOf(4), short.heightOf(4));
  });

  it("reports the height of any prefix", () => {
    const layout = resultsLayout([1, 2, 1, 1], options);
    assert.equal(layout.heightOf(0), 0);
    assert.equal(layout.heightOf(1), 100);
    assert.equal(layout.heightOf(2), 200);
    assert.equal(layout.heightOf(4), 210);
    assert.equal(layout.heightOf(99), 210);
  });

  it("handles one column and no items", () => {
    assert.deepEqual(resultsLayout([1, 1], { ...options, columns: 1 }).rects.map((r) => r.y), [0, 110]);
    assert.equal(resultsLayout([], options).heightOf(5), 0);
  });
});
