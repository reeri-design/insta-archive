import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUrlFor, parseInstagramUrl } from "./instagram-url.ts";
import { decodeExportText } from "./text.ts";

test("shortcode is the identity regardless of path form and query", () => {
  const urls = [
    "https://www.instagram.com/p/Abc_123-x/",
    "https://www.instagram.com/reel/Abc_123-x/?id=3995476004365134320_8228012933",
    "https://www.instagram.com/p/Abc_123-x/?carousel_share_child_media_id=3978319684633888767_38343213362",
    "https://instagram.com/someone/p/Abc_123-x",
  ];
  for (const url of urls) {
    const parsed = parseInstagramUrl(url);
    assert.ok(parsed.ok, url);
    assert.deepEqual(parsed.content.identity, { kind: "shortcode", shortcode: "Abc_123-x" });
  }
});

test("kind hints come only from the URL form", () => {
  const hint = (url: string) => {
    const parsed = parseInstagramUrl(url);
    return parsed.ok ? parsed.content.kindHint : "error";
  };
  assert.equal(hint("https://www.instagram.com/reel/X1/"), "reel");
  assert.equal(hint("https://www.instagram.com/p/X1/?carousel_share_child_media_id=1_2"), "carousel");
  assert.equal(hint("https://www.instagram.com/p/X1/"), undefined);
});

test("carousel child media id is kept but does not affect identity", () => {
  const parsed = parseInstagramUrl("https://www.instagram.com/p/X1/?carousel_share_child_media_id=1_2");
  assert.ok(parsed.ok);
  assert.equal(parsed.content.carouselChildMediaId, "1_2");
});

test("non-content URLs are rejected with a reason", () => {
  assert.deepEqual(parseInstagramUrl("https://www.instagram.com/stories/someone/123"), {
    ok: false,
    reason: "story link (not a post or reel)",
  });
  assert.equal(parseInstagramUrl("http://example.com/").ok, false);
  assert.equal(parseInstagramUrl("https://www.instagram.com/someone/").ok, false);
  assert.equal(parseInstagramUrl("nonsense").ok, false);
});

test("canonical URL uses /reel/ for reels and /p/ otherwise", () => {
  const identity = { kind: "shortcode", shortcode: "X1" } as const;
  assert.equal(canonicalUrlFor(identity, "reel"), "https://www.instagram.com/reel/X1/");
  assert.equal(canonicalUrlFor(identity, "carousel"), "https://www.instagram.com/p/X1/");
});

test("export mojibake is decoded; normal text is untouched", () => {
  assert.equal(decodeExportText("itâ\u0080\u0099s ð\u009f\u008e¨"), "it’s 🎨");
  assert.equal(decodeExportText("ZoÃ«"), "Zoë");
  assert.equal(decodeExportText("plain ascii"), "plain ascii");
  assert.equal(decodeExportText("already fine ’"), "already fine ’");
  assert.equal(decodeExportText("lone latin-1 é"), "lone latin-1 é");
});
