import { useSyncExternalStore } from "react";
import type { LibraryItem } from "../library/library-item.ts";
import { createShuffleStore, type ShuffleSnapshot } from "../library/shuffle-store.ts";
import { shuffleLibrary } from "./library-actions.ts";

/** The tab's Shuffle (see shuffle-store.ts), shared by the nav's button and the library canvas. */
export const libraryShuffle = createShuffleStore<LibraryItem>(shuffleLibrary);

const SERVER_SNAPSHOT: ShuffleSnapshot<LibraryItem> = { version: 0, pending: false };

export function useLibraryShuffle(): ShuffleSnapshot<LibraryItem> {
  return useSyncExternalStore(libraryShuffle.subscribe, libraryShuffle.getSnapshot, () => SERVER_SNAPSHOT);
}
