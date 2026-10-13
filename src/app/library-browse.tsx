"use client";

import { useState } from "react";
import type { LibraryItem } from "../library/library-item.ts";
import { LibraryCanvas } from "./library-canvas.tsx";
import { useLibraryShuffle } from "./library-shuffle.ts";

/**
 * The canvas, showing the whole archive or the current Shuffle (see
 * shuffle-store.ts), which outlives this page, so coming back to the library
 * shows the same selection. A new selection is a new canvas: its camera and focus
 * start afresh, rather than from a view saved for another selection.
 */
export function LibraryBrowse({ items }: { items: LibraryItem[] }) {
  const shuffle = useLibraryShuffle();
  // Only the selection the page opened with may restore a saved view (Back from Details).
  const [openedWith] = useState(shuffle.version);
  return (
    <LibraryCanvas
      key={shuffle.version}
      items={shuffle.items ?? items}
      restoreView={shuffle.version === openedWith}
    />
  );
}
