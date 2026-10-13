/**
 * Shuffle's choice of items: a random selection of the archive, never the
 * same item twice in one selection. Successive Shuffles are independent, so
 * an item may come back in a later one.
 *
 * The archive is ordered by a seeded hash of each id and the first `size`
 * taken: the same seed always gives the same selection (for tests); a fresh
 * seed (randomSeed) gives a fresh one.
 *
 * Pure: no database, no DOM.
 */

/** How many items one Shuffle puts on the canvas (which repeats them to fill the field). */
export const SHUFFLE_SIZE = 120;

export function shuffleSelection<T extends string>(ids: readonly T[], seed: string, size = SHUFFLE_SIZE): T[] {
  if (ids.length === 0 || size < 1) return [];
  const h = hash(seed);
  return [...new Set(ids)]
    .map((id) => ({ id, key: hash(id, h) }))
    .sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : 1))
    .slice(0, size)
    .map(({ id }) => id);
}

export function randomSeed(): string {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return a!.toString(36) + b!.toString(36);
}

/** FNV-1a over the string, from `seed`, finished with murmur3's mix so nearby inputs spread out. */
function hash(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
