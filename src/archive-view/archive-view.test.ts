import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AiOrganization, AiOrganizationId, ArchiveItemId, MediaAsset, MediaAssetId, UserId } from "../domain/archive-item.ts";
import { ingestInstagramExport } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import { LocalMediaStorage } from "../media/local-media-storage.ts";
import { storageKeyFor } from "../media/media-storage.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";
import {
  getItemDetail,
  identityFromKey,
  itemKey,
  listArchiveCards,
  readItemMedia,
  saveItemReview,
  searchArchiveCards,
} from "./archive-view.ts";
import { buildCuratedOrganization, parseReviewInput, ReviewInputError, reviewInputFrom } from "./review.ts";

const FIXTURES = join(import.meta.dirname, "../importers/instagram/__fixtures__");
const OWNER = "owner-1" as UserId;
const OTHER = "owner-2" as UserId;
const T0 = "2026-10-03T12:00:00.000Z";
const T1 = "2026-10-04T08:30:00.000Z";
const id = (shortcode: string) => `owner-1:shortcode:${shortcode}` as ArchiveItemId;

const SUGGESTION: AiOrganization = {
  id: `${id("CarouBBB222")}:ai:${T0}` as AiOrganizationId,
  archiveItemId: id("CarouBBB222"),
  fields: {
    type: "inspiration", category: "craft", tags: ["embroidery", "sketchbook", "floral motifs"],
    summary: "An embroidered sketchbook page.", usefulFor: ["stitch reference"],
  },
  confidence: 0.8,
  taxonomyVersion: "v1",
  provider: "fake-ai",
  model: "fake-model-1",
  promptVersion: "organize-v1/media",
  createdAt: T0,
};

let dir: string;
let db: DatabaseSync;
let repo: SqliteArchiveRepository;
let storage: LocalMediaStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "insta-archive-view-"));
  db = openDatabase(join(dir, "test.sqlite"));
  repo = new SqliteArchiveRepository(db);
  storage = new LocalMediaStorage(join(dir, "media"));
  await ingestInstagramExport(repo, readExportDirectory(FIXTURES).files, { ownerId: OWNER, importedAt: T0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function storeSlide(position: number, text: string, status: "stored" | "failed" = "stored") {
  const assetId = `${id("CarouBBB222")}:media:${position}` as MediaAssetId;
  const base = { id: assetId, archiveItemId: id("CarouBBB222"), mediaType: "image" as const, role: "content" as const, position };
  if (status === "failed") {
    await repo.saveMediaAssets([{ ...base, retrieval: { status: "failed", lastAttemptAt: T0, attempts: 1, error: "boom" } } as MediaAsset]);
    return;
  }
  const key = storageKeyFor(base.archiveItemId, assetId, "image/jpeg");
  await storage.put(key, new TextEncoder().encode(text));
  await repo.saveMediaAssets([{ ...base, retrieval: { status: "stored", storageKey: key, mimeType: "image/jpeg", retrievedAt: T0 } }]);
}
const curatedRows = () => db.prepare("SELECT * FROM curated_organizations").all();
const aiRows = () => db.prepare("SELECT * FROM ai_organizations ORDER BY id").all();

describe("routes", () => {
  test("item keys round-trip for shortcodes and URL identities, and reject anything else", () => {
    assert.equal(itemKey({ kind: "shortcode", shortcode: "Dd3iw4pubES" }), "Dd3iw4pubES");
    assert.deepEqual(identityFromKey("Dd3iw4pubES"), { kind: "shortcode", shortcode: "Dd3iw4pubES" });
    const url = { kind: "url", normalizedUrl: "https://www.instagram.com/stories/x/1/" } as const;
    assert.deepEqual(identityFromKey(itemKey(url)), url);
    assert.equal(identityFromKey("../etc/passwd"), undefined);
  });
});

describe("browse", () => {
  test("cards show creator, sources and organization, prefer stored media, and paginate", async () => {
    await storeSlide(1, "slide 1");
    await storeSlide(0, "slide 0");
    await repo.appendAiOrganization(SUGGESTION);

    const all = await listArchiveCards(repo, OWNER, { pageSize: 50 });
    assert.equal(all.hasNext, false);
    const carousel = all.cards.find((c) => c.href === "/items/CarouBBB222");
    assert.ok(carousel);
    assert.deepEqual(carousel.preview, { mediaType: "image", url: "/items/CarouBBB222/media/media%3A0" }); // first slide by position
    assert.equal(carousel.storedMediaCount, 2);
    assert.equal(carousel.reviewStatus, "ai_suggested");
    assert.deepEqual(carousel.organization, { type: "inspiration", category: "craft" });

    const reel = all.cards.find((c) => c.href === "/items/ReelAAA111");
    assert.deepEqual([reel?.preview, reel?.storedMediaCount, reel?.reviewStatus], [undefined, 0, "unorganized"]); // metadata fallback
    assert.equal(reel?.creator?.username, "example_artist");
    assert.deepEqual(reel?.sources, ["liked", "messages", "saved"]);

    const first = await listArchiveCards(repo, OWNER, { pageSize: 2 });
    const second = await listArchiveCards(repo, OWNER, { pageSize: 2, page: 2 });
    assert.deepEqual([first.cards.length, first.hasNext, second.page], [2, true, 2]);
    assert.ok(!second.cards.some((c) => first.cards.some((f) => f.href === c.href)));
    assert.deepEqual((await listArchiveCards(repo, OTHER)).cards, []); // per owner
  });
});

describe("search", () => {
  test("returns main-archive cards with match details and a total; liked-only items never appear", async () => {
    await repo.appendAiOrganization(SUGGESTION); // CarouBBB222: tags embroidery, sketchbook, floral motifs
    const result = await searchArchiveCards(repo, OWNER, "Embroidery");
    assert.deepEqual([result.total, result.hasNext, result.page], [1, false, 1]);
    assert.equal(result.cards[0]?.href, "/items/CarouBBB222");
    assert.deepEqual(result.cards[0]?.matchedFields, ["tags"]); // the summary says "embroidered"

    // PostCCC333 is liked-only: even an exact match on its own caption finds nothing.
    const liked = await repo.getArchiveItemAggregate(id("PostCCC333"));
    const caption = liked?.item.original.caption?.value ?? liked?.item.original.creator?.value.username;
    assert.ok(caption, "fixture has searchable text");
    const hidden = await searchArchiveCards(repo, OWNER, caption);
    assert.ok(!hidden.cards.some((c) => c.href === "/items/PostCCC333"));
  });
});

describe("main archive scope (Saved + Messages)", () => {
  test("a liked-only item is left out of the grid, detail, media and review; its data stays stored", async () => {
    // Fixtures: PostCCC333 is liked-only; ReelAAA111 is saved + messages + liked.
    const { cards } = await listArchiveCards(repo, OWNER, { pageSize: 50 });
    assert.ok(!cards.some((c) => c.href === "/items/PostCCC333"));
    assert.deepEqual(cards.find((c) => c.href === "/items/ReelAAA111")?.sources, ["liked", "messages", "saved"]); // liked record kept
    assert.equal(await getItemDetail(repo, OWNER, "PostCCC333"), undefined);
    await assert.rejects(saveItemReview(repo, OWNER, "PostCCC333", reviewInputFrom(undefined), T1), /No archive item/);
    assert.ok(await repo.getArchiveItemAggregate(id("PostCCC333"))); // still in storage
  });
});

describe("detail", () => {
  test("shows stored media in order, missing media with its status, and the latest suggestion", async () => {
    await storeSlide(2, "slide 2");
    await storeSlide(0, "slide 0");
    await storeSlide(1, "slide 1", "failed");
    await repo.appendAiOrganization(SUGGESTION);
    const newer = { ...SUGGESTION, id: `${id("CarouBBB222")}:ai:${T1}` as AiOrganizationId, createdAt: T1, confidence: 0.6 };
    await repo.appendAiOrganization(newer);

    const detail = await getItemDetail(repo, OWNER, "CarouBBB222");
    assert.ok(detail);
    assert.deepEqual(detail.media.map((m) => [m.position, m.url]), [
      [0, "/items/CarouBBB222/media/media%3A0"],
      [2, "/items/CarouBBB222/media/media%3A2"],
    ]);
    assert.deepEqual(detail.missingMedia, [{ position: 1, mediaType: "image", status: "failed" }]);
    assert.equal(detail.suggestion?.id, newer.id);
    assert.equal(await getItemDetail(repo, OTHER, "CarouBBB222"), undefined); // another owner's archive
    assert.equal(await getItemDetail(repo, OWNER, "NoSuchItem1"), undefined);
  });

  test("a Reel whose video was withheld shows its cover image as the preview and, separately, on the detail view", async () => {
    const reel = id("ReelAAA111");
    await repo.saveMediaAssets([{
      id: `${reel}:media:0` as MediaAssetId, archiveItemId: reel, mediaType: "video", role: "content", position: 0,
      retrieval: { status: "unavailable", checkedAt: T0, reason: "restricted", detail: "Embed page has no video URL" },
    }]);
    const coverId = `${reel}:cover` as MediaAssetId;
    const key = storageKeyFor(reel, coverId, "image/jpeg");
    await storage.put(key, new TextEncoder().encode("cover"));
    await repo.saveMediaAssets([{ id: coverId, archiveItemId: reel, mediaType: "image", role: "cover", retrieval: { status: "stored", storageKey: key, mimeType: "image/jpeg", retrievedAt: T0 } }]);

    const card = (await listArchiveCards(repo, OWNER, { pageSize: 50 })).cards.find((c) => c.href === "/items/ReelAAA111");
    assert.deepEqual([card?.preview, card?.storedMediaCount], [{ mediaType: "image", url: "/items/ReelAAA111/media/cover" }, 0]);
    const detail = await getItemDetail(repo, OWNER, "ReelAAA111");
    assert.deepEqual([detail?.media, detail?.cover], [[], { mediaType: "image", url: "/items/ReelAAA111/media/cover" }]);
    assert.deepEqual(detail?.missingMedia, [{ position: 0, mediaType: "video", status: "unavailable" }]);
    const served = await readItemMedia(repo, storage, OWNER, "ReelAAA111", "cover");
    assert.deepEqual([new TextDecoder().decode(served?.bytes), served?.mimeType], ["cover", "image/jpeg"]);
  });

  test("media bytes are served only for the owner's stored assets", async () => {
    await storeSlide(0, "slide 0");
    await storeSlide(1, "slide 1", "failed");
    const media = await readItemMedia(repo, storage, OWNER, "CarouBBB222", "media%3A0");
    assert.deepEqual([new TextDecoder().decode(media?.bytes), media?.mimeType], ["slide 0", "image/jpeg"]);
    assert.ok(await readItemMedia(repo, storage, OWNER, "CarouBBB222", "media:0")); // decoded form too
    assert.equal(await readItemMedia(repo, storage, OWNER, "CarouBBB222", "media:1"), undefined); // not stored
    assert.equal(await readItemMedia(repo, storage, OTHER, "CarouBBB222", "media:0"), undefined);
    assert.equal(await readItemMedia(repo, storage, OWNER, "CarouBBB222", "../../etc/passwd"), undefined);
  });
});

describe("review", () => {
  test("form input is normalized: trimmed, blank entries dropped, duplicates removed", () => {
    assert.deepEqual(
      parseReviewInput({
        type: "  inspiration ", category: "",
        tags: "embroidery, Sketchbook\n\nsketchbook\n floral motifs ",
        summary: "   ",
        usefulFor: "stitch reference, small format\n\nStitch Reference, small format",
      }),
      { type: "inspiration", tags: ["embroidery", "Sketchbook", "floral motifs"], usefulFor: ["stitch reference, small format"] },
    );
    assert.throws(() => parseReviewInput({ ...reviewInputFrom(undefined), summary: "x".repeat(2001) }), ReviewInputError);
    assert.throws(() => parseReviewInput({ ...reviewInputFrom(undefined), tags: Array.from({ length: 31 }, (_, i) => `t${i}`).join("\n") }), ReviewInputError);
  });

  test("the form starts from the suggestion's values and parses back to the same fields", () => {
    assert.deepEqual(parseReviewInput(reviewInputFrom(SUGGESTION.fields)), SUGGESTION.fields);
  });

  test("field origins record what was accepted, edited, cleared or added", () => {
    const curated = buildCuratedOrganization({
      archiveItemId: SUGGESTION.archiveItemId,
      fields: { type: "inspiration", category: "art", tags: ["embroidery", "sketchbook", "floral motifs"], usefulFor: [] },
      suggestion: { ...SUGGESTION, fields: { ...SUGGESTION.fields, summary: undefined } as AiOrganization["fields"] },
      reviewedBy: OWNER,
      reviewedAt: T1,
    });
    assert.deepEqual(curated.fieldOrigins, { type: "ai_accepted", category: "human_edited", tags: "ai_accepted", usefulFor: "human_edited" });
    const added = buildCuratedOrganization({ archiveItemId: SUGGESTION.archiveItemId, fields: { tags: ["a"], usefulFor: [] }, reviewedBy: OWNER, reviewedAt: T1 });
    assert.deepEqual([added.fieldOrigins, added.basedOnSuggestionId, added.taxonomyVersion], [{ tags: "human_added" }, undefined, "v1"]);
  });

  test("saving a review stores the CuratedOrganization and never changes the AI suggestion", async () => {
    await repo.appendAiOrganization(SUGGESTION);
    const before = aiRows();

    const curated = await saveItemReview(repo, OWNER, "CarouBBB222", {
      ...reviewInputFrom(SUGGESTION.fields),
      category: "art",
      tags: "embroidery\nsketchbook\nfloral motifs\nminiature",
    }, T1);
    assert.deepEqual(curated, {
      archiveItemId: id("CarouBBB222"),
      fields: { ...SUGGESTION.fields, category: "art", tags: ["embroidery", "sketchbook", "floral motifs", "miniature"] },
      fieldOrigins: { type: "ai_accepted", category: "human_edited", tags: "human_edited", summary: "ai_accepted", usefulFor: "ai_accepted" },
      basedOnSuggestionId: SUGGESTION.id,
      taxonomyVersion: "v1",
      reviewedBy: OWNER,
      reviewedAt: T1,
    });
    const detail = await getItemDetail(repo, OWNER, "CarouBBB222");
    assert.deepEqual([detail?.reviewStatus, detail?.aggregate.curated], ["reviewed", curated]);
    assert.deepEqual(aiRows(), before); // the suggestion is untouched

    // Saving again replaces the single curated organization.
    await saveItemReview(repo, OWNER, "CarouBBB222", reviewInputFrom(SUGGESTION.fields), T1);
    assert.equal(curatedRows().length, 1);
    assert.deepEqual((await getItemDetail(repo, OWNER, "CarouBBB222"))?.aggregate.curated?.fields, SUGGESTION.fields);
    assert.deepEqual(aiRows(), before);
  });

  test("an item without a suggestion can be reviewed; another owner's item cannot", async () => {
    const curated = await saveItemReview(repo, OWNER, "ReelAAA111", { type: "reference", category: "", tags: "clay", summary: "", usefulFor: "" }, T1);
    assert.deepEqual(curated.fieldOrigins, { type: "human_added", tags: "human_added" });
    await assert.rejects(saveItemReview(repo, OTHER, "ReelAAA111", reviewInputFrom(undefined), T1), /No archive item/);
    assert.equal(curatedRows().length, 1);
  });
});
