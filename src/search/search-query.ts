/**
 * Simple, explainable keyword search over the archive: the query and the
 * searched text are normalized the same way, and query terms match the start
 * of words (so "embroider" finds "embroidery"). No embeddings, no AI calls.
 */

/** A query term. CJK terms match anywhere, since those scripts don't separate words with spaces. */
export type SearchTerm = { text: string; anywhere: boolean };

/** Fields a search looks in, with the weight a matching term adds to the score. */
export const SEARCH_FIELD_WEIGHTS = {
  tags: 3,
  creator: 3,
  type: 2,
  category: 2,
  summary: 2,
  usefulFor: 2,
  caption: 1,
} as const;

export type SearchField = keyof typeof SEARCH_FIELD_WEIGHTS;

/**
 * The item's organization (curated, else AI): what the item is about, as
 * opposed to words that merely appear in its caption or creator name.
 * Matches here rank first.
 */
export const ORGANIZATION_SEARCH_FIELDS: readonly SearchField[] = ["tags", "type", "category", "summary", "usefulFor"];

const MAX_TERMS = 8;

/** Common English words that carry no meaning in a search on their own. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "i", "in", "is", "it", "me", "my",
  "of", "on", "or", "so", "that", "the", "this", "to", "was", "with", "about", "some", "something",
]);

const CJK = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Lowercases (Unicode-aware), turns everything but letters and digits into
 * single spaces, and trims. Used for both the query and the searched text.
 */
export function normalizeSearchText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Splits a natural-language query into up to 8 distinct terms, dropping
 * common words (unless the query has nothing else). An empty result means
 * "no search".
 */
export function parseSearchQuery(query: string): SearchTerm[] {
  const words = [...new Set(normalizeSearchText(query).split(" ").filter(Boolean))];
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  return (meaningful.length > 0 ? meaningful : words)
    .slice(0, MAX_TERMS)
    .map((text) => ({ text, anywhere: CJK.test(text) }));
}
