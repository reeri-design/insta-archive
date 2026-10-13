import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { focusWidth, MAX_TILE_RATIO, MIN_TILE_RATIO, textShape, tileRatio, UNKNOWN_MEDIA_RATIO } from "./library-layout.ts";

describe("tileRatio", () => {
  const image = (width?: number, height?: number) => ({
    preview: { mediaType: "image" as const, url: "/x", ...(width && height && { width, height }) },
  });

  it("uses the stored size of the media", () => {
    assert.equal(tileRatio(image(1080, 1350)), 1.25);
    assert.equal(tileRatio(image(1080, 1080)), 1);
  });

  it("clamps extreme shapes", () => {
    assert.equal(tileRatio(image(1080, 5000)), MAX_TILE_RATIO);
    assert.equal(tileRatio(image(3000, 500)), MIN_TILE_RATIO);
  });

  it("does not invent a size when none is stored", () => {
    assert.equal(tileRatio(image()), UNKNOWN_MEDIA_RATIO);
  });

  it("shapes media-less tiles by caption length", () => {
    assert.equal(tileRatio({}), textShape(undefined).ratio);
    assert.ok(tileRatio({ caption: "short" }) < tileRatio({ caption: "x".repeat(400) }));
    assert.equal(textShape("   ").lines, 0);
  });
});

describe("focusWidth", () => {
  it("is about 1.5× a tile, readable on a phone, and keeps tall media within the height limit", () => {
    assert.equal(focusWidth(222, { viewportWidth: 1440, maxMediaHeight: 600 }), 333);
    assert.equal(focusWidth(179, { viewportWidth: 390, maxMediaHeight: 600 }), 320);
    assert.equal(focusWidth(222, { viewportWidth: 1440, ratio: 1.78, maxMediaHeight: 500 }), Math.round(500 / 1.78));
    assert.equal(focusWidth(222, { viewportWidth: 1440, ratio: 4, maxMediaHeight: 500 }), Math.round(1.2 * 222)); // not below 1.2×
  });
});
