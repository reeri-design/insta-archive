import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOrganizationOutput } from "./organization-schema.ts";

const valid = {
  type: "inspiration",
  category: "craft",
  tags: ["embroidery", "sketchbook", "floral motifs"],
  summary: "A small embroidered sketchbook page with floral motifs.",
  usefulFor: ["stitch pattern reference"],
  confidence: 0.82,
};

test("a complete, well-formed output is accepted (tags trimmed and de-duplicated)", () => {
  const result = validateOrganizationOutput({ ...valid, tags: [" embroidery", "Sketchbook", "sketchbook", "floral motifs"] });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.fields.tags, ["embroidery", "Sketchbook", "floral motifs"]);
  assert.equal(result.value.confidence, 0.82);
});

test("malformed outputs are rejected with reasons", () => {
  const cases: [unknown, RegExp][] = [
    [null, /not a JSON object/],
    [[valid], /not a JSON object/],
    ["{}", /not a JSON object/],
    [{ ...valid, type: "meme" }, /type must be one of/],
    [{ ...valid, category: "Craft" }, /category must be one of/],
    [{ ...valid, tags: ["a", "b"] }, /tags must have 3–7/],
    [{ ...valid, tags: ["a", "b", "c", "d", "e", "f", "g", "h"] }, /tags must have 3–7/],
    [{ ...valid, tags: ["a", "A", "a "] }, /tags must have 3–7 distinct entries, got 1/],
    [{ ...valid, tags: ["a", "", "c"] }, /empty entry/],
    [{ ...valid, usefulFor: [] }, /usefulFor must have 1–5/],
    [{ ...valid, summary: "  " }, /summary must be a non-empty string/],
    [{ ...valid, confidence: 1.4 }, /confidence must be a number between 0 and 1/],
    [{ ...valid, confidence: "0.8" }, /confidence must be a number/],
    [{ ...valid, whySaved: "they liked it" }, /unexpected field "whySaved"/],
    [{ type: valid.type, category: valid.category, tags: valid.tags, usefulFor: valid.usefulFor, confidence: valid.confidence }, /summary must be a non-empty string/],
  ];
  for (const [output, error] of cases) {
    const result = validateOrganizationOutput(output);
    assert.equal(result.ok, false, JSON.stringify(output));
    if (!result.ok) assert.match(result.errors.join("; "), error);
  }
});
