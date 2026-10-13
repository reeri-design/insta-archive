import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomSeed, shuffleSelection } from "./shuffle.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `item-${String(i).padStart(5, "0")}`);
const sorted = (xs: string[]) => [...xs].sort();

describe("shuffleSelection", () => {
  const archive = ids(1000);

  test("a selection is `size` distinct items of the archive, in a shuffled order", () => {
    const selection = shuffleSelection(archive, "abc", 120);
    assert.equal(selection.length, 120);
    assert.equal(new Set(selection).size, 120);
    assert.ok(selection.every((id) => archive.includes(id)));
    assert.notDeepEqual(selection, sorted(selection)); // not the archive's own order
  });

  test("the same seed gives the same selection; another seed another one", () => {
    const a = shuffleSelection(archive, "abc", 120);
    assert.deepEqual(shuffleSelection(archive, "abc", 120), a);
    const b = shuffleSelection(archive, "xyz", 120);
    assert.ok(b.filter((id) => a.includes(id)).length < 60, "another seed is a different selection");
  });

  test("successive random seeds give different selections; items may repeat across them", () => {
    const selections = Array.from({ length: 5 }, () => shuffleSelection(archive, randomSeed(), 120).join());
    assert.ok(new Set(selections).size > 1, "fresh seeds choose afresh");
    // A small archive is shown whole each time: every item repeats, never within one selection.
    const small = ids(7);
    for (let i = 0; i < 5; i++) assert.deepEqual(sorted(shuffleSelection(small, randomSeed(), 120)), small);
    const orders = new Set(Array.from({ length: 8 }, () => shuffleSelection(small, randomSeed(), 120).join()));
    assert.ok(orders.size > 1, "a small archive is reordered");
  });

  test("an empty archive gives nothing; duplicate ids are shown once", () => {
    assert.deepEqual(shuffleSelection([], "abc"), []);
    assert.deepEqual(sorted(shuffleSelection(["a", "b", "a"], "abc", 10)), ["a", "b"]);
  });
});
