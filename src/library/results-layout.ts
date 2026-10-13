/**
 * The search results grid: a finite masonry in ranked order. Each item, best
 * match first, goes into the shortest column (leftmost on a tie), so reading
 * across and down follows the ranking and every item appears exactly once.
 * Unlike the canvas (canvas-layout.ts) nothing repeats and nothing pans.
 * No React, no Node APIs.
 */

export type GridRect = { x: number; y: number; width: number; height: number };

export type ResultsLayout = {
  rects: GridRect[];
  /** Bottom of the lowest item among the first n (prefix-stable: laying out more never moves earlier items). */
  heightOf: (n: number) => number;
};

/** Lays out items of height ÷ width `ratios` in `columns` columns of `columnWidth`, `gap` apart. */
export function resultsLayout(ratios: readonly number[], options: { columns: number; columnWidth: number; gap: number }): ResultsLayout {
  const columns = Math.max(1, Math.floor(options.columns));
  const { columnWidth, gap } = options;
  const bottoms = new Array<number>(columns).fill(0);
  const rects = ratios.map((ratio) => {
    let column = 0;
    for (let c = 1; c < columns; c++) if (bottoms[c]! < bottoms[column]!) column = c;
    const height = Math.round(columnWidth * ratio);
    const rect = { x: column * (columnWidth + gap), y: bottoms[column]!, width: columnWidth, height };
    bottoms[column] = rect.y + height + gap;
    return rect;
  });
  // Running maximum of item bottoms, so any prefix's height is a lookup.
  const prefix: number[] = [0];
  for (const r of rects) prefix.push(Math.max(prefix.at(-1)!, r.y + r.height));
  return { rects, heightOf: (n) => prefix[Math.max(0, Math.min(n, rects.length))]! };
}
