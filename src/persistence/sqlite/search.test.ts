import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type {
  AiOrganizationId,
  ArchiveItemId,
  Creator,
  OrganizationFields,
  SourceKind,
  SourceRecordId,
  UserId,
} from "../../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../../domain/archive-scope.ts";
import { normalizeSearchText, parseSearchQuery } from "../../search/search-query.ts";
import { openDatabase } from "./database.ts";
import { SqliteArchiveRepository } from "./sqlite-archive-repository.ts";

const OWNER = "owner-1" as UserId;
const T0 = "2026-10-01T09:00:00.000Z";
const id = (sc: string) => `owner-1:shortcode:${sc}` as ArchiveItemId;

let repo: SqliteArchiveRepository;

/** Adds an item with the given sources, original metadata and organization. */
async function addItem(
  sc: string,
  options: {
    sources: SourceKind[];
    creator?: Creator;
    caption?: string;
    ai?: Partial<OrganizationFields>;
    curated?: Partial<OrganizationFields>;
    at?: string;
  },
) {
  const itemId = id(sc);
  await repo.saveArchiveItem({
    id: itemId, ownerId: OWNER, identity: { kind: "shortcode", shortcode: sc }, kind: "post",
    canonicalUrl: `https://www.instagram.com/p/${sc}/`, createdAt: T0, updatedAt: T0,
  });
  await repo.addSourceRecords(options.sources.map((source) => ({
    id: `${sc}:${source}` as SourceRecordId, archiveItemId: itemId, source,
    originalUrl: `https://www.instagram.com/p/${sc}/`, occurredAt: options.at ?? T0,
    exportLocation: { file: `${source}.json` }, raw: {}, importedAt: T0,
  })));
  const provenance = { from: "export", sourceRecordId: `${sc}:${options.sources[0]}` as SourceRecordId } as const;
  await repo.saveOriginalMetadata(itemId, {
    ...(options.creator && { creator: { value: options.creator, provenance } }),
    ...(options.caption && { caption: { value: options.caption, provenance } }),
  });
  if (options.ai) {
    await repo.appendAiOrganization({
      id: `${itemId}:ai` as AiOrganizationId, archiveItemId: itemId, fields: { tags: [], usefulFor: [], ...options.ai },
      confidence: 0.9, taxonomyVersion: "v1", provider: "fake", model: "fake-1", promptVersion: "organize-v1/media", createdAt: T0,
    });
  }
  if (options.curated) {
    await repo.saveCuratedOrganization({
      archiveItemId: itemId, fields: { tags: [], usefulFor: [], ...options.curated }, fieldOrigins: {},
      taxonomyVersion: "v1", reviewedBy: OWNER, reviewedAt: T0,
    });
  }
}

const search = (query: string, page: { limit?: number; offset?: number } = {}) =>
  repo.searchArchiveItems(OWNER, query, { sources: MAIN_ARCHIVE_SOURCES, ...page });
const ids = async (query: string) => (await search(query)).hits.map((h) => h.item.identity.kind === "shortcode" && h.item.identity.shortcode);

beforeEach(async () => {
  repo = new SqliteArchiveRepository(openDatabase(":memory:"));
  // No AI organization: findable only through original metadata.
  await addItem("Embroid1", {
    sources: ["saved"], creator: { username: "m.esa_art", displayName: "Mesa" }, caption: "embroidery in a tiny sketchbook",
    at: "2026-09-01T00:00:00.000Z",
  });
  await addItem("Crayon2", {
    sources: ["messages"], creator: { username: "mydoriart" }, caption: "Back to the little things #crayonart",
    ai: { type: "inspiration", category: "art", tags: ["crayon art", "cat illustration"], summary: "Colorful crayon drawings of cats.", usefulFor: ["color palette reference"] },
  });
  await addItem("LikedOnly3", {
    sources: ["liked"], caption: "embroidery hoop patterns",
    ai: { tags: ["embroidery", "hoop"], summary: "Embroidery hoop art.", usefulFor: ["stitch reference"] },
  });
  await addItem("LikedSaved4", {
    sources: ["liked", "saved"], creator: { username: "threadwork" }, caption: "new sampler",
    ai: { type: "reference", category: "craft", tags: ["embroidery", "floral motifs"], summary: "A floral embroidery sampler.", usefulFor: ["stitch reference"] },
    at: "2026-08-01T00:00:00.000Z",
  });
  await addItem("Ceramic5", {
    sources: ["liked", "messages"], creator: { username: "clayhouse", displayName: "Clay House" }, caption: "new mugs out now",
    ai: { type: "reference", category: "craft", tags: ["ceramics", "glaze"], summary: "Glazed ceramic mugs.", usefulFor: ["glaze color reference"] },
  });
  await addItem("Poster6", {
    sources: ["saved", "messages", "liked"], caption: "studio wall",
    ai: { tags: ["typography"], usefulFor: [] },
    curated: { tags: ["poster design"], usefulFor: [] }, // the review replaces the AI tags for search
  });
  await addItem("Paris7", { sources: ["messages"], caption: "Café sketches, ÉTÉ à Paris" });
});

describe("search matches each field", () => {
  test("caption", async () => {
    assert.deepEqual(await ids("sketchbook"), ["Embroid1"]);
  });

  test("creator username and display name", async () => {
    assert.deepEqual(await ids("mydoriart"), ["Crayon2"]);
    const byName = await search("clay house");
    assert.deepEqual([byName.hits[0]?.item.id, byName.hits[0]?.matchedFields], [id("Ceramic5"), ["creator"]]);
  });

  test("AI tags", async () => {
    const result = await search("glaze");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.matchedFields]), [[id("Ceramic5"), ["tags", "summary", "usefulFor"]]]); // also "Glazed" in the summary
  });

  test("AI usefulFor", async () => {
    const result = await search("stitch");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.matchedFields]), [[id("LikedSaved4"), ["usefulFor"]]]);
  });

  test("AI summary", async () => {
    const result = await search("cats"); // "cat illustration" does not start with "cats"
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.matchedFields]), [[id("Crayon2"), ["summary"]]]);
  });

  test("AI type and category", async () => {
    assert.deepEqual((await ids("reference")).sort(), ["Ceramic5", "Crayon2", "LikedSaved4"]); // type, or usefulFor "color palette reference"
    assert.deepEqual((await ids("craft")).sort(), ["Ceramic5", "LikedSaved4"]);
  });

  test("a curated organization replaces the AI suggestion for search", async () => {
    assert.deepEqual(await ids("poster"), ["Poster6"]);
    assert.deepEqual(await ids("typography"), []);
  });
});

describe("query handling", () => {
  test("is case-insensitive, including non-ASCII letters", async () => {
    assert.deepEqual(await ids("EMBROIDERY Sampler"), await ids("embroidery sampler"));
    assert.deepEqual(await ids("CAFÉ"), ["Paris7"]);
    assert.deepEqual(await ids("été"), ["Paris7"]);
  });

  test("terms match the start of words, not the middle", async () => {
    assert.deepEqual(await ids("embroid"), ["LikedSaved4", "Embroid1"]); // prefix of "embroidery"
    assert.deepEqual(await ids("crayon"), ["Crayon2"]); // also the hashtag "crayonart"
    assert.deepEqual(await ids("ramic"), []);
  });

  test("an empty or punctuation-only query matches nothing", async () => {
    assert.deepEqual(await search(""), { total: 0, hits: [] });
    assert.deepEqual(await search("  #!? "), { total: 0, hits: [] });
  });
});

describe("scope", () => {
  test("liked-only items are never returned; liked items that were also saved or shared are", async () => {
    assert.deepEqual(await ids("hoop"), []); // only LikedOnly3 mentions it
    assert.ok(!(await ids("embroidery")).includes("LikedOnly3"));
    assert.deepEqual(await ids("threadwork"), ["LikedSaved4"]); // liked + saved
    assert.deepEqual(await ids("mugs"), ["Ceramic5"]); // liked + messages
    assert.deepEqual(await ids("studio"), ["Poster6"]); // saved + messages + liked
    assert.deepEqual(await ids("Paris"), ["Paris7"]); // messages only
    // Without the scope the liked-only item is there, so the filter is what excludes it.
    const all = await repo.searchArchiveItems(OWNER, "hoop", { sources: ["saved", "messages", "liked"] });
    assert.deepEqual(all.hits.map((h) => h.item.id), [id("LikedOnly3")]);
  });
});

describe("ranking", () => {
  test("items whose organization matches come first, ahead of caption or creator matches of more terms", async () => {
    // "embroidery": LikedSaved4's organization matches (tags + summary); Embroid1 only has it in its caption.
    const one = await search("embroidery");
    assert.deepEqual(one.hits.map((h) => [h.item.id, h.organizationTerms, h.matchedTerms, h.score]), [
      [id("LikedSaved4"), 1, 1, 5],
      [id("Embroid1"), 0, 1, 1],
    ]);
    // "embroidery sketchbook café": Embroid1's caption matches two terms and Paris7's one, but
    // LikedSaved4's organization says it is about embroidery, so it ranks first.
    const mixed = await search("embroidery sketchbook café");
    assert.deepEqual(mixed.hits.map((h) => [h.item.id, h.organizationTerms, h.matchedTerms]), [
      [id("LikedSaved4"), 1, 1],
      [id("Embroid1"), 0, 2], // caption-only matches are still found, more terms first
      [id("Paris7"), 0, 1],
    ]);
  });

  test("among organized items, matching more terms in the organization ranks higher", async () => {
    // "glaze reference": Ceramic5 matches both in its organization; Crayon2 and LikedSaved4 only "reference".
    const result = await search("glaze reference");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.organizationTerms]), [
      [id("Ceramic5"), 2],
      [id("LikedSaved4"), 1], // type "reference" (2) + usefulFor "stitch reference" (2) = 4
      [id("Crayon2"), 1], // usefulFor "color palette reference" = 2
    ]);
    assert.ok(result.hits[1]!.score > result.hits[2]!.score);
  });

  test("a creator match still ranks above caption-only matches when no organization matches", async () => {
    await addItem("Threads8", { sources: ["saved"], caption: "my threadwork notes" }); // caption only
    assert.deepEqual(await ids("threadwork"), ["LikedSaved4", "Threads8"]); // creator (3) before caption (1)
  });

  test("common words are ignored", async () => {
    // "ideas for a floral sampler" behaves like "ideas floral sampler".
    const natural = await search("ideas for a floral sampler");
    assert.deepEqual(natural.hits.map((h) => [h.item.id, h.organizationTerms, h.matchedTerms]), [[id("LikedSaved4"), 2, 2]]);
  });

  test("results paginate with a stable total", async () => {
    const first = await search("reference", { limit: 2 });
    const rest = await search("reference", { limit: 2, offset: 2 });
    assert.deepEqual([first.total, first.hits.length, rest.total, rest.hits.length], [3, 2, 3, 1]);
    assert.ok(!rest.hits.some((h) => first.hits.some((f) => f.item.id === h.item.id)));
  });
});

describe("query parsing", () => {
  test("normalizes, drops common words and duplicates, caps the term count, and marks CJK terms", () => {
    assert.equal(normalizeSearchText("  Café—ÉTÉ #crayonArt!! "), "café été crayonart");
    assert.deepEqual(parseSearchQuery("The Embroidery, embroidery & floral ideas").map((t) => t.text), ["embroidery", "floral", "ideas"]);
    assert.deepEqual(parseSearchQuery("the of a").map((t) => t.text), ["the", "of", "a"]); // nothing else left: keep them
    assert.equal(parseSearchQuery("a b c d e f g h i j k").length, 8);
    assert.deepEqual(parseSearchQuery("귀여운 cat"), [{ text: "귀여운", anywhere: true }, { text: "cat", anywhere: false }]);
  });
});
