/**
 * Simple, explainable keyword search over the archive: the query and the
 * searched text are normalized the same way, and query terms match the start
 * of words (so "embroider" finds "embroidery"). No embeddings, no AI calls.
 *
 * This module turns a query into a SearchPlan (terms, their variants, the
 * phrases between them, and how each field counts for each term); the
 * repository only renders the plan as a query over its storage.
 */

/**
 * Fields a search looks in, with the weight of a term matching there. A term
 * scores its single best field (repeating a word across fields earns
 * nothing extra). Specific fields (tags, creator) weigh most and the literal
 * caption next; descriptive or generic AI fields (summary, the fixed
 * type/category vocabulary) only assist, so a generic word matched there
 * never outweighs a literal caption match. usefulFor is formulaic AI text
 * ("… ideas", "inspiration for …", "color palette reference …"): it weighs
 * least, holds no phrases, and never counts toward corroboration (see
 * NON_CORROBORATING_FIELDS); generic words earn nothing there (see GENERIC_TERMS).
 */
export const SEARCH_FIELD_WEIGHTS = {
  tags: 3,
  creator: 3,
  caption: 2,
  summary: 1,
  usefulFor: 0.5,
  type: 1,
  category: 1,
} as const;

export type SearchField = keyof typeof SEARCH_FIELD_WEIGHTS;

/**
 * The item's organization (curated, else AI), as opposed to the original
 * caption and creator. Reported per hit (organizationTerms) to explain where
 * a match came from; ranking itself uses SEARCH_FIELD_WEIGHTS.
 */
export const ORGANIZATION_SEARCH_FIELDS: readonly SearchField[] = ["tags", "type", "category", "summary", "usefulFor"];

/** Fields that find an item and count toward coverage, but not toward corroboration (repeating the AI's boilerplate is no evidence). */
export const NON_CORROBORATING_FIELDS: readonly SearchField[] = ["usefulFor"];

/**
 * Weight of the query's words appearing together as a phrase, by field. A
 * phrase in the item's own caption or creator name is the strongest evidence.
 * A phrase in AI tags weighs as much only when the item has no caption (the
 * AI's description is then all the text it has); next to a caption that
 * doesn't say it, the AI's phrase is an addition and weighs less
 * (CAPTIONED_TAG_PHRASE_WEIGHT). usefulFor, type and category hold no phrases.
 */
export const PHRASE_FIELD_WEIGHTS = { caption: 3, creator: 3, tags: 3, summary: 1 } as const;
export const CAPTIONED_TAG_PHRASE_WEIGHT = 2;

export type PhraseField = keyof typeof PHRASE_FIELD_WEIGHTS;

/**
 * Words the AI uses as boilerplate in usefulFor and type ("ideas",
 * "inspiration", "reference"), given in their singular form. As query terms
 * they don't match creator names, don't count toward coverage or join phrases
 * when the query has other words, weigh at most 1, and earn nothing in
 * usefulFor or type.
 */
export const GENERIC_TERMS: ReadonlySet<string> = new Set(["idea", "inspiration", "inspo", "reference"]);

/** The most a generic term adds to the score, wherever it matches. */
const GENERIC_TERM_MAX_WEIGHT = 1;

/** Fields a generic term finds items in without adding to their score. */
const GENERIC_UNWEIGHTED_FIELDS: readonly SearchField[] = ["usefulFor", "type"];

/** Terms shorter than this match whole words only ("ui" must not match "uiuxmobile"). */
export const MIN_PREFIX_LENGTH = 4;

const MAX_TERMS = 8;

/** At most this many common words may sit between two terms of a phrase ("black and white"). */
const MAX_PHRASE_GAP = 2;

/** Common English words that carry no meaning in a search on their own. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "i", "in", "is", "it", "me", "my",
  "of", "on", "or", "so", "that", "the", "this", "to", "was", "with", "about", "some", "something",
]);

/** British spellings, rewritten to American ones in the query and the searched text alike (also inside words: "watercolour"). */
const SPELLINGS: Readonly<Record<string, string>> = {
  colour: "color",
  favour: "favor",
  flavour: "flavor",
  grey: "gray",
  jewellery: "jewelry",
  centre: "center",
  theatre: "theater",
};
const SPELLING_PATTERN = new RegExp(Object.keys(SPELLINGS).join("|"), "g");

const CJK = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN_WORD = /^\p{Script=Latin}+$/u;

/** How a term or phrase text matches: anywhere (CJK), at the start of a word, or as a whole word. */
export type MatchMode = "anywhere" | "prefix" | "word";
export type MatchText = { text: string; mode: MatchMode };

export type SearchTerm = {
  /** The term as normalized from the query. */
  text: string;
  /** Texts any of which counts as a match: the term, its singular forms or "-ies" plural, and for short words their plurals. */
  variants: MatchText[];
  generic: boolean;
  /** Whether matching this term counts toward coverage (false for a generic term next to non-generic ones). */
  counts: boolean;
};

/** Two neighbouring terms, as written in the query (with any common words between), plus their joined hashtag form. */
export type SearchPhrase = { variants: MatchText[] };

export type SearchPlan = { terms: SearchTerm[]; phrases: SearchPhrase[] };

/** How a field counts for a term: its score weight, and whether a match there counts toward coverage. */
export type TermFieldRule = { weight: number; covers: boolean };

/**
 * Lowercases (Unicode-aware), turns everything but letters and digits into
 * single spaces, and trims.
 */
export function normalizeSearchText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** normalizeSearchText plus American spellings. Used for both the query and the searched text. */
export function searchText(text: string | null | undefined): string {
  return normalizeSearchText(text).replace(SPELLING_PATTERN, (m) => SPELLINGS[m]!);
}

/**
 * A list field (tags, usefulFor) as searched text: each entry normalized,
 * joined by " | " so a phrase never runs from one entry into the next.
 */
export function searchTextOfList(values: readonly unknown[]): string {
  return values
    .map((v) => searchText(typeof v === "string" ? v : null))
    .filter(Boolean)
    .join(" | ");
}

/** Light singular forms of an English plural: "cats" → "cat", "stories" → "story"/"storie", "boxes" → "box". */
export function singularForms(word: string): string[] {
  if (word.length < MIN_PREFIX_LENGTH || !LATIN_WORD.test(word)) return [];
  if (word.endsWith("ies") && word.length >= 5) return [`${word.slice(0, -3)}y`, word.slice(0, -1)];
  if (/(x|ch|sh|ss|z)es$/.test(word)) return [word.slice(0, -2), word.slice(0, -1)];
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return [word.slice(0, -1)];
  return [];
}

/** The "-ies" plural of a word ending in consonant + "y" ("story" → "stories"), which a prefix match can't reach. */
export function iesPlural(word: string): string | undefined {
  return word.length >= MIN_PREFIX_LENGTH && LATIN_WORD.test(word) && /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : undefined;
}

/** A text and how it matches; a short whole word also matches its plural ("bag" finds "bags"). */
function matchTexts(text: string): MatchText[] {
  if (CJK.test(text)) return [{ text, mode: "anywhere" }];
  const last = text.slice(text.lastIndexOf(" ") + 1);
  if (last.length >= MIN_PREFIX_LENGTH) return [{ text, mode: "prefix" }];
  return [text, `${text}s`, `${text}es`].map((t) => ({ text: t, mode: "word" }));
}

function dedupe(variants: MatchText[]): MatchText[] {
  const seen = new Set<string>();
  return variants.filter((v) => {
    const key = `${v.mode}:${v.text}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/**
 * Turns a natural-language query into up to 8 distinct terms (dropping
 * common words) and the phrases between neighbouring terms. A query of only
 * common words, or nothing, gives no terms: "no search".
 */
export function planSearch(query: string): SearchPlan {
  const words = searchText(query).split(" ").filter(Boolean);
  // Positions of the first occurrence of each meaningful word, up to MAX_TERMS.
  const positions: number[] = [];
  const seen = new Set<string>();
  words.forEach((w, i) => {
    if (STOPWORDS.has(w) || seen.has(w) || positions.length >= MAX_TERMS) return;
    seen.add(w);
    positions.push(i);
  });

  const base = positions.map((i) => {
    const text = words[i]!;
    const singulars = singularForms(text);
    const plural = iesPlural(text);
    return {
      text,
      variants: dedupe([text, ...singulars, ...(plural ? [plural] : [])].flatMap(matchTexts)),
      generic: [text, ...singulars].some((t) => GENERIC_TERMS.has(t)),
    };
  });
  const allGeneric = base.every((t) => t.generic);
  const terms = base.map((t) => ({ ...t, counts: !t.generic || allGeneric }));

  // Phrases join neighbouring terms that count; a generic word ("ideas") modifies, it doesn't belong to a phrase.
  const phrases: SearchPhrase[] = [];
  const counting = positions.filter((_, k) => terms[k]!.counts);
  for (let k = 0; k + 1 < counting.length; k++) {
    const [from, to] = [counting[k]!, counting[k + 1]!];
    const span = words.slice(from, to + 1);
    const between = span.slice(1, -1);
    if (between.length > MAX_PHRASE_GAP || !between.every((w) => STOPWORDS.has(w))) continue;
    if (span.some((w) => CJK.test(w))) continue;
    const last = span.at(-1)!;
    const lastForm = singularForms(last)[0] ?? last;
    const variants = matchTexts([...span.slice(0, -1), lastForm].join(" "));
    // The hashtag form of two adjacent words: "#crossstitch", "#packagingdesign".
    if (span.length === 2) variants.push({ text: `${span[0]}${lastForm}`, mode: "prefix" });
    phrases.push({ variants: dedupe(variants) });
  }
  return { terms, phrases };
}

/** How `field` counts for `term`, or undefined if the term is not looked for there. */
export function termFieldRule(term: SearchTerm, field: SearchField): TermFieldRule | undefined {
  if (!term.generic) return { weight: SEARCH_FIELD_WEIGHTS[field], covers: term.counts };
  if (field === "creator") return undefined; // "inspiration" must not find @daily.inspiration
  // A generic word only assists: at most GENERIC_TERM_MAX_WEIGHT, and nothing for the AI's own boilerplate fields.
  const weight = GENERIC_UNWEIGHTED_FIELDS.includes(field) ? 0 : Math.min(GENERIC_TERM_MAX_WEIGHT, SEARCH_FIELD_WEIGHTS[field]);
  const covers = term.counts && weight > 0;
  return { weight, covers };
}
