"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { LibraryItem } from "../../library/library-item.ts";
import { resultsLayout } from "../../library/results-layout.ts";
import { RETURN_KEY } from "../items/[key]/back-link.tsx";
import { Tile } from "../library-tile.tsx";

/** The view (scroll, how many results are drawn) kept in this history entry when Details opens, for Back. */
const VIEW_KEY = "searchView";
/** Results are drawn in batches as you scroll, so a broad query doesn't load hundreds of images at once. */
const BATCH = 90;

type SavedView = { scrollY: number; shown: number };
type Metrics = { columns: number; columnWidth: number; gap: number };

function savedView(): SavedView | undefined {
  if (typeof window === "undefined") return undefined;
  const view = window.history.state?.[VIEW_KEY] as SavedView | undefined;
  return view && typeof view.scrollY === "number" && typeof view.shown === "number" ? view : undefined;
}

/**
 * Search results as a dense grid, in the search engine's ranked order: best
 * match first, reading across and down (results-layout.ts), each item once.
 * The page scrolls normally; more results are drawn as you near the end.
 *
 * Search is for scanning, so there is no Focus here: a result opens its
 * Details directly, and Back returns to this query at the same scroll position.
 */
export function SearchResults({ items }: { items: LibraryItem[] }) {
  const grid = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics>();
  // Returning (Back from Details): start from the view this history entry remembers.
  const [restored] = useState(savedView);
  const [shown, setShown] = useState(() => Math.min(items.length, Math.max(BATCH, restored?.shown ?? 0)));

  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const columns = Number.parseInt(style.getPropertyValue("--results-columns"), 10) || 6;
      const gap = Number.parseFloat(style.getPropertyValue("--results-gap")) || 12;
      const next: Metrics = { columns, columnWidth: Math.max(1, Math.floor((element.clientWidth - gap * (columns - 1)) / columns)), gap };
      setMetrics((prev) => (prev && prev.columns === next.columns && prev.columnWidth === next.columnWidth && prev.gap === next.gap ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => metrics && resultsLayout(items.map((i) => i.ratio), metrics), [items, metrics]);

  // Back from Details: once the grid has its size again, return to where you were.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (!layout || scrolled.current) return;
    scrolled.current = true;
    if (restored) window.scrollTo(0, restored.scrollY);
  }, [layout, restored]);

  // Draw the next batch as the end of what is drawn comes near.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || shown >= items.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(items.length, n + BATCH));
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown, items.length, layout]);

  /** Opening a result: keep the view in this history entry (no new entry), and mark the way back for Details. */
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest("[data-focus-key], [data-details-link]")) return;
    const view: SavedView = { scrollY: window.scrollY, shown };
    window.history.replaceState({ ...window.history.state, [VIEW_KEY]: view }, "", window.location.href);
    try {
      sessionStorage.setItem(RETURN_KEY, window.location.href);
    } catch {
      // Storage unavailable: Details' Back falls back to the library.
    }
  };

  const drawn = layout ? Math.min(shown, items.length) : 0;
  return (
    <>
      <div
        ref={grid}
        className="results-grid"
        data-ready={layout ? "true" : "false"}
        style={{ height: layout?.heightOf(drawn) }}
        onClickCapture={onClickCapture}
      >
        {layout?.rects.slice(0, drawn).map((rect, i) => {
          const item = items[i]!;
          return (
            <div
              key={item.key}
              className="results-cell"
              style={{ width: rect.width, height: rect.height, transform: `translate(${rect.x}px, ${rect.y}px)` }}
            >
              {/* The card, and its Details pill, both go straight to Details. */}
              <Tile item={item} href={item.detailsHref} occurrence={String(i)} />
            </div>
          );
        })}
      </div>
      {drawn < items.length && <div ref={sentinel} className="results-more" aria-hidden="true" />}
    </>
  );
}
