"use server";

import { getArchiveCard, listShuffledArchiveCards } from "../archive-view/archive-view.ts";
import { libraryItemOf, type LibraryItem } from "../library/library-item.ts";
import type { ShuffleRequest } from "../library/shuffle-store.ts";
import { archiveRepository, OWNER_ID } from "./archive-server.ts";

/**
 * Shuffle (see library/shuffle-store.ts): a fresh random selection of the main
 * archive for the canvas. Liked-only items stay out. `keep` (the item in
 * Focus) is added when the selection does not already hold it.
 */
export async function shuffleLibrary(request: ShuffleRequest): Promise<LibraryItem[]> {
  const cards = await listShuffledArchiveCards(archiveRepository(), OWNER_ID);
  const keep = typeof request?.keep === "string" ? request.keep : undefined;
  const extra = keep && !cards.some((c) => c.key === keep) ? await getArchiveCard(archiveRepository(), OWNER_ID, keep) : undefined;
  return [...cards, ...(extra ? [extra] : [])].map(libraryItemOf);
}
