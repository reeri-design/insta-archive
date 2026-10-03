import assert from "node:assert/strict";
import { test } from "node:test";
import { parseByteRange } from "./byte-range.ts";

test("byte ranges: explicit, open-ended, suffix, clamped, unsatisfiable and ignored forms", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=0-1", 1000), { start: 0, end: 1 }); // Safari's probe
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.equal(parseByteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=50-10", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseByteRange(null, 1000), undefined);
  assert.equal(parseByteRange("bytes=0-1,5-9", 1000), undefined); // multiple ranges: whole body
  assert.equal(parseByteRange("items=0-1", 1000), undefined);
  assert.equal(parseByteRange("bytes=-", 1000), undefined);
});
