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
import { normalizeSearchText, planSearch, searchText, singularForms } from "../../search/search-query.ts";
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
    const result = await search("drawings");
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

  test("an empty, punctuation-only or common-words-only query matches nothing", async () => {
    assert.deepEqual(await search(""), { total: 0, hits: [] });
    assert.deepEqual(await search("  #!? "), { total: 0, hits: [] });
    assert.deepEqual(await search("the of a"), { total: 0, hits: [] });
    assert.deepEqual(await search("a"), { total: 0, hits: [] }); // not a search for every word starting with "a"
  });

  test("short terms match whole words only, not the start of longer ones", async () => {
    await addItem("Ui8", { sources: ["saved"], creator: { username: "uiuxmobile" }, caption: "fun app screens" });
    await addItem("Ui9", { sources: ["saved"], caption: "kung fu poster for the #ui class" });
    assert.deepEqual(await ids("ui"), ["Ui9"]);
    assert.deepEqual(await ids("fu"), ["Ui9"]);
    assert.deepEqual(await ids("uiux"), ["Ui8"]); // long enough to match as a prefix
  });

  test("singular and plural forms find each other", async () => {
    await addItem("Cat8", { sources: ["saved"], caption: "my cat at the window" });
    await addItem("Cat9", { sources: ["messages"], caption: "two cats asleep", at: "2026-09-02T00:00:00.000Z" });
    await addItem("Box10", { sources: ["saved"], caption: "a box of stories" });
    assert.deepEqual((await ids("cat")).sort(), ["Cat8", "Cat9", "Crayon2"]); // Crayon2: tag "cat illustration", summary "cats"
    assert.deepEqual((await ids("cats")).sort(), ["Cat8", "Cat9", "Crayon2"]);
    assert.deepEqual(await ids("boxes"), ["Box10"]);
    assert.deepEqual(await ids("story"), ["Box10"]);
    assert.deepEqual(await ids("category"), []); // "cat" no longer reaches into longer words
  });

  test("British and American spellings find each other, also inside hashtags", async () => {
    await addItem("Colour8", { sources: ["saved"], caption: "#watercolourart grey skies" });
    await addItem("Color9", { sources: ["saved"], ai: { tags: ["watercolor"], usefulFor: [] } });
    assert.deepEqual((await ids("watercolour")).sort(), ["Color9", "Colour8"]);
    assert.deepEqual((await ids("watercolor")).sort(), ["Color9", "Colour8"]);
    assert.deepEqual(await ids("gray"), ["Colour8"]);
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
  test("items matching more of the query come first, whatever the field", async () => {
    // "embroidery sketchbook café": Embroid1's caption matches two terms; LikedSaved4 (AI tag) and Paris7 (caption) one each.
    const mixed = await search("embroidery sketchbook café");
    assert.deepEqual(mixed.hits.map((h) => [h.item.id, h.matchedTerms, h.score]), [
      [id("Embroid1"), 2, 4], // caption 2 + caption 2
      [id("LikedSaved4"), 1, 3], // a specific AI tag (3) beats...
      [id("Paris7"), 1, 2], // ...a caption mention (2) at equal coverage
    ]);
  });

  test("a full literal caption match beats a single generic AI match", async () => {
    await addItem("GenericAI8", {
      sources: ["saved"], caption: "studio day",
      ai: { type: "inspiration", category: "art", summary: "A painting inspiration post.", usefulFor: ["visual inspiration for painting"] },
    });
    await addItem("Watercolor9", { sources: ["messages"], caption: "my watercolor painting process" });
    const result = await search("watercolor painting");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.matchedTerms]), [[id("Watercolor9"), 2], [id("GenericAI8"), 1]]);
  });

  test("a generic word repeated across AI fields does not outrank a literal caption match", async () => {
    // "inspiration" is GenericAI8's type, summary and usefulFor; next to "outfit" it doesn't count toward
    // coverage, earns nothing in type or usefulFor, and at most 1 elsewhere.
    await addItem("GenericAI8", {
      sources: ["saved"], caption: "studio day",
      ai: { type: "inspiration", category: "design", summary: "A design inspiration post.", usefulFor: ["inspiration for layouts"] },
    });
    await addItem("Outfit10", { sources: ["messages"], caption: "outfit check for autumn" });
    const result = await search("outfit inspiration");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.matchedTerms, h.score, h.matchedFields.length]), [
      [id("Outfit10"), 1, 2, 1],
      [id("GenericAI8"), 0, 1, 3], // more fields, but only the generic word
      [id("Crayon2"), 0, 0, 1], // its type is "inspiration" too: found, but last
    ]);
  });

  test("generic words do not match creator names, unless nothing else in the query does", async () => {
    await addItem("Daily8", { sources: ["saved"], creator: { username: "daily.inspiration" }, caption: "app screens" });
    await addItem("Sketch9", { sources: ["saved"], caption: "sketchbook spread with ideas for inspiration" });
    assert.deepEqual(await ids("inspiration"), ["Sketch9", "Crayon2"]); // Crayon2: AI type "inspiration", found but unweighted
    assert.deepEqual(await ids("sketchbook inspiration"), ["Sketch9", "Embroid1", "Crayon2"]); // Crayon2 by its type alone, last
    assert.equal((await ids("daily inspiration"))[0], "Daily8"); // a non-generic word still finds the creator
  });

  test("boilerplate in usefulFor weighs least: a caption or tag match of the same words ranks first", async () => {
    await addItem("Boiler8", { sources: ["saved"], caption: "beach day", ai: { tags: ["travel"], usefulFor: ["color palette reference"] } });
    await addItem("Palette9", { sources: ["saved"], caption: "my favourite colour palette" });
    const ranked = (await search("color palette reference")).hits.map((h) => h.item.id);
    assert.equal(ranked[0], id("Palette9"));
    assert.ok(ranked.indexOf(id("Boiler8")) > 0);
  });

  test("caption-less items stay discoverable through their AI tags and summary", async () => {
    await addItem("NoCaption11", { sources: ["messages"], ai: { tags: ["packaging design", "gift boxes"], summary: "Festive gift box packaging." } });
    await addItem("BoxCaption12", { sources: ["saved"], caption: "packing my boxes for the move" });
    const one = await search("packaging");
    assert.deepEqual(one.hits.map((h) => [h.item.id, h.matchedFields]), [[id("NoCaption11"), ["tags", "summary"]]]);
    // A specific tag outranks a caption mention, so it leads even a broader query.
    const two = await search("gift boxes");
    assert.deepEqual(two.hits.map((h) => [h.item.id, h.matchedTerms, h.score]), [[id("NoCaption11"), 2, 6], [id("BoxCaption12"), 1, 2]]);
  });

  test("at equal coverage and score, matching in more fields ranks higher", async () => {
    // "craft": LikedSaved4 and Ceramic5 both match only their category (weight 1); a summary mention adds corroboration.
    await addItem("Craft8", {
      sources: ["saved"], at: "2026-09-30T00:00:00.000Z",
      ai: { category: "craft", summary: "A craft fair stall.", tags: [], usefulFor: [] },
    });
    const result = await search("craft");
    assert.deepEqual(result.hits.map((h) => [h.item.id, h.score, h.matchedFields.length])[0], [id("Craft8"), 1, 2]);
  });

  test("recency only breaks exact ties: an older, more complete match beats a newer partial one", async () => {
    await addItem("OldFull8", { sources: ["saved"], caption: "teal lantern by the door", at: "2020-01-01T00:00:00.000Z" });
    await addItem("NewPartial9", { sources: ["saved"], caption: "teal sky", at: "2026-09-30T00:00:00.000Z" });
    await addItem("NewTie10", { sources: ["saved"], caption: "lantern festival", at: "2026-09-29T00:00:00.000Z" });
    await addItem("OldTie11", { sources: ["saved"], caption: "paper lantern", at: "2021-01-01T00:00:00.000Z" });
    // "lantern teal": no phrase anywhere, so coverage then recency decide.
    assert.deepEqual(await ids("lantern teal"), ["OldFull8", "NewPartial9", "NewTie10", "OldTie11"]);
    assert.deepEqual(await ids("lantern"), ["NewTie10", "OldTie11", "OldFull8"]);
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

describe("phrases", () => {
  test("words that occur together rank above the same words apart", async () => {
    await addItem("Apart8", { sources: ["saved"], caption: "a stitch in time, cross the road", at: "2026-09-30T00:00:00.000Z" });
    await addItem("Together9", { sources: ["saved"], caption: "my cross stitch phone case", at: "2020-01-01T00:00:00.000Z" });
    const result = await search("cross stitch");
    assert.deepEqual(result.hits.slice(0, 2).map((h) => [h.item.id, h.matchedTerms, h.phraseScore]), [
      [id("Together9"), 2, 3],
      [id("Apart8"), 2, 0],
    ]);
  });

  test("a hashtag joining the words counts as the phrase", async () => {
    await addItem("Hashtag8", { sources: ["saved"], caption: "new kit out #crossstitch and stitch markers" });
    await addItem("Apart9", { sources: ["saved"], caption: "stitch then cross over", at: "2026-09-30T00:00:00.000Z" });
    assert.deepEqual((await ids("cross stitch")).slice(0, 2), ["Hashtag8", "Apart9"]);
  });

  test("common words may sit inside a phrase", async () => {
    await addItem("Bw8", { sources: ["saved"], caption: "black and white film" });
    await addItem("Bw9", { sources: ["saved"], caption: "white walls, black floor", at: "2026-09-30T00:00:00.000Z" });
    assert.deepEqual(await ids("black and white"), ["Bw8", "Bw9"]);
  });

  test("a caption phrase outranks an AI tag phrase on a captioned item; a caption-less item's tags stand in for a caption", async () => {
    await addItem("TagPhrase8", {
      sources: ["saved"], caption: "tiny sketchbook page", at: "2026-09-30T00:00:00.000Z",
      ai: { tags: ["cross stitch"], usefulFor: [] },
    });
    await addItem("CaptionPhrase9", { sources: ["saved"], caption: "my cross stitch phone case", at: "2020-01-01T00:00:00.000Z" });
    await addItem("NoCaption10", { sources: ["saved"], ai: { tags: ["cross stitch", "hoop art"], summary: "A cross stitch hoop.", usefulFor: [] } });
    const result = await search("cross stitch");
    assert.deepEqual(result.hits.slice(0, 3).map((h) => [h.item.id, h.phraseScore]), [
      [id("NoCaption10"), 3], // as strong a phrase as a caption's, and a higher score (tags)
      [id("CaptionPhrase9"), 3],
      [id("TagPhrase8"), 2], // the AI added the phrase; the caption doesn't say it
    ]);
  });

  test("phrases do not run from one tag into the next", async () => {
    await addItem("Tags8", { sources: ["saved"], ai: { tags: ["tiny cross", "stitch markers"], usefulFor: [] } });
    const result = await search("cross stitch");
    assert.equal(result.hits.find((h) => h.item.id === id("Tags8"))?.phraseScore, 0);
  });
});

describe("query parsing", () => {
  test("normalizes, drops common words and duplicates, caps the term count, and marks CJK terms", () => {
    assert.equal(normalizeSearchText("  Café—ÉTÉ #crayonArt!! "), "café été crayonart");
    assert.equal(searchText("Watercolour, GREY & Colourful"), "watercolor gray colorful");
    const terms = (q: string) => planSearch(q).terms.map((t) => t.text);
    assert.deepEqual(terms("The Embroidery, embroidery & floral ideas"), ["embroidery", "floral", "ideas"]);
    assert.deepEqual(terms("the of a"), []); // nothing meaningful: no search
    assert.equal(terms("aa bb cc dd ee ff gg hh ii jj kk").length, 8);
    assert.deepEqual(planSearch("귀여운 cat").terms.map((t) => [t.text, t.variants.map((v) => v.mode)]), [
      ["귀여운", ["anywhere"]],
      ["cat", ["word", "word", "word"]], // cat, cats, cates
    ]);
  });

  test("generic words count only when the query has nothing else", () => {
    assert.deepEqual(planSearch("sketchbook ideas").terms.map((t) => [t.text, t.generic, t.counts]), [
      ["sketchbook", false, true],
      ["ideas", true, false],
    ]);
    assert.deepEqual(planSearch("ideas").terms.map((t) => [t.text, t.counts]), [["ideas", true]]);
    assert.equal(planSearch("sketchbook ideas").phrases.length, 0); // a generic word joins no phrase
  });

  test("singular forms", () => {
    assert.deepEqual(singularForms("cats"), ["cat"]);
    assert.deepEqual(singularForms("stories"), ["story", "storie"]);
    assert.deepEqual(singularForms("boxes"), ["box", "boxe"]);
    assert.deepEqual(singularForms("glass"), []);
    assert.deepEqual(singularForms("paris"), []);
    assert.deepEqual(singularForms("bus"), []); // too short to guess
  });
});
