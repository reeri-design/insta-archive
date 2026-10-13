/**
 * Shuffle on the library, in place: what the canvas shows when it is not the
 * whole archive. A Shuffle fetches a fresh selection from the server and puts
 * it here; the canvas swaps it in. Nothing goes in the URL or history, so a
 * Shuffle is not a navigation: Back, Focus and Search work as before.
 *
 * The store outlives the library page within the tab (module state in the
 * browser), so leaving for Details or Search and coming back, by any link or
 * Back, shows the same selection. Only a new Shuffle replaces it; a full
 * reload (a fresh store) shows the whole archive again.
 *
 * Pure: no React, no DOM, no Next.js (see app/library-shuffle.ts for the wiring).
 */
export type ShuffleSnapshot<T> = {
  /** The current Shuffle's items, or undefined for the whole archive. */
  items?: T[];
  /** Bumped by every change of selection, so each one can start a fresh canvas. */
  version: number;
  /** A Shuffle is being fetched. */
  pending: boolean;
};

export type ShuffleRequest = {
  /** An item to keep in the new selection (the one in Focus), so the open Focus stays valid. */
  keep?: string;
};

export type ShuffleStore<T> = {
  getSnapshot(): ShuffleSnapshot<T>;
  subscribe(listener: () => void): () => void;
  /** Fetches a fresh selection and shows it. If another Shuffle follows before it arrives, it is dropped. */
  shuffle(request?: ShuffleRequest): Promise<void>;
};

export function createShuffleStore<T>(fetchSelection: (request: ShuffleRequest) => Promise<T[]>): ShuffleStore<T> {
  let snapshot: ShuffleSnapshot<T> = { version: 0, pending: false };
  let latest = 0;
  const listeners = new Set<() => void>();
  const set = (next: ShuffleSnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async shuffle(request = {}) {
      const id = ++latest;
      set({ ...snapshot, pending: true });
      let items: T[];
      try {
        items = await fetchSelection(request);
      } catch (error) {
        // The canvas keeps what it shows.
        if (id === latest) set({ ...snapshot, pending: false });
        console.error("Shuffle failed", error);
        return;
      }
      if (id !== latest) return;
      // An empty archive has nothing to shuffle; keep what is shown.
      set(items.length > 0 ? { items, version: snapshot.version + 1, pending: false } : { ...snapshot, pending: false });
    },
  };
}
