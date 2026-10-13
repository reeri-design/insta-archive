import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArchiveCard } from "../archive-view/archive-view.ts";
import { excerptOf, libraryItemOf, sourceNameOf, TEXT_LENGTH, titleOf } from "./library-item.ts";

const card = (overrides: Partial<ArchiveCard> = {}): ArchiveCard => ({
  key: "ABC123",
  href: "/items/ABC123",
  kind: "reel",
  creator: { username: "someone" },
  sources: ["saved"],
  storedMediaCount: 0,
  reviewStatus: "unorganized",
  mediaState: "pending",
  viewable: [],
  sourceUrl: "https://www.instagram.com/reel/ABC123/",
  ...overrides,
});

describe("libraryItemOf", () => {
  it("keeps a media-less item's caption (bounded) and no title", () => {
    const item = libraryItemOf(card({ caption: "word ".repeat(200) }));
    assert.ok(item.text && item.text.length <= TEXT_LENGTH + 1);
    assert.equal(item.title, undefined);
    assert.deepEqual(item.source, { name: "Instagram", handle: "@someone", url: "https://www.instagram.com/reel/ABC123/" });
    assert.equal(item.label, "Reel by @someone");
  });

  it("gives a media item identifying text from its caption, and no caption body", () => {
    const viewable = [{ mediaType: "image" as const, url: "/items/ABC123/media/x", width: 1080, height: 1350, role: "content" as const }];
    const item = libraryItemOf(card({ caption: "Altitude high. More words here #travel", viewable, preview: { mediaType: "image", url: "/x" }, mediaState: "available" }));
    assert.equal(item.title, "Altitude high.");
    assert.equal(item.text, undefined);
    assert.equal(item.matched, undefined);
  });

  it("labels search matches", () => {
    assert.equal(libraryItemOf(card({ matchedFields: ["caption", "usefulFor"] })).matched, "caption · useful for");
  });
});

describe("caption helpers", () => {
  it("takes the first readable line or sentence, without trailing hashtags, never inventing", () => {
    assert.equal(titleOf("#art #paint\nAfter visiting Rajasthan, I knew I had to paint. Then more."), "After visiting Rajasthan, I knew I had to paint.");
    assert.equal(titleOf("Gently breezing #nature #slowliving"), "Gently breezing");
    assert.equal(titleOf("#only #tags"), undefined);
  });

  it("excerpts at word boundaries", () => {
    assert.equal(excerptOf("one two three", 9), "one two…");
    assert.equal(excerptOf("  short\n text ", 50), "short text");
  });

  it("names the source in human terms", () => {
    assert.equal(sourceNameOf("https://www.instagram.com/p/X/"), "Instagram");
    assert.equal(sourceNameOf("not a url"), "Original");
  });
});
