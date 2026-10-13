/**
 * The library canvas: an unbounded field of archive items, in canvas
 * coordinates, independent of what is on screen.
 *
 *   archive items → canvas coordinates (here) → camera → what you see
 *
 * Columns run without end in both directions, and each column is an endless
 * sequence of items, upward and downward. Items repeat (the archive is
 * finite); repetition exists only here, never in the archive itself. Every
 * position is deterministic, so the field never reshuffles between renders.
 *
 * Arrangement: column c, row k shows the item at position q = k + c·STRIDE of
 * the archive's order (newest first), with positions shuffled within small
 * blocks per column. So the newest items gather around the origin, older ones
 * further out, neighbouring columns never show the same stretch side by side,
 * and a column never shows the same item twice in a row. Columns start at
 * different heights and gaps vary slightly, so rows never line up.
 *
 * Pure: no DOM, no React.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** One appearance of an archive item on the canvas. */
export type Occurrence = Rect & {
  /** Stable for this position: "column:row". */
  id: string;
  /** Index into the item list. */
  index: number;
  column: number;
  row: number;
};

/** Positions advanced per column (see the module comment). */
const STRIDE = 16;
/** Positions are shuffled within blocks of this size, per column. */
const BLOCK = 8;

export class ArchiveCanvas {
  readonly columnWidth: number;
  readonly gap: number;
  readonly count: number;
  private readonly ratios: readonly number[];
  private readonly stride: number;
  private readonly columns = new Map<number, Column>();

  constructor(options: { ratios: readonly number[]; columnWidth: number; gap: number }) {
    this.ratios = options.ratios;
    this.count = options.ratios.length;
    this.columnWidth = options.columnWidth;
    this.gap = options.gap;
    // Small sets cannot be block-shuffled without repeating within a block; step by
    // half the set instead, so neighbouring columns stay out of phase.
    this.stride = this.count >= 2 * BLOCK ? STRIDE : Math.max(1, Math.floor(this.count / 2));
  }

  /** The item shown at column `column`, row `row` (any integers). */
  itemAt(column: number, row: number): number {
    const n = this.count;
    const q = row + column * this.stride;
    if (n < 2 * BLOCK) return mod(q, n);
    const block = Math.floor(q / BLOCK);
    return mod(block * BLOCK + permutation(column, block)[mod(q, BLOCK)]!, n);
  }

  columnX(column: number): number {
    return column * (this.columnWidth + this.gap);
  }

  /** Every occurrence overlapping `rect` (canvas coordinates). */
  occurrencesIn(rect: Rect): Occurrence[] {
    if (this.count === 0) return [];
    const pitch = this.columnWidth + this.gap;
    const first = Math.floor(rect.x / pitch);
    const last = Math.floor((rect.x + rect.width) / pitch);
    const out: Occurrence[] = [];
    for (let c = first; c <= last; c++) {
      const column = this.column(c);
      for (const row of column.rowsIn(rect.y, rect.y + rect.height)) out.push(this.occurrence(c, row));
    }
    return out;
  }

  occurrence(column: number, row: number): Occurrence {
    const c = this.column(column);
    return {
      id: `${column}:${row}`,
      index: this.itemAt(column, row),
      column,
      row,
      x: this.columnX(column),
      y: c.top(row),
      width: this.columnWidth,
      height: c.height(row),
    };
  }

  /** The occurrence of item `index` nearest `point`, searching outward from it. */
  findOccurrence(index: number, point: { x: number; y: number }): Occurrence | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const pitch = this.columnWidth + this.gap;
    const centre = Math.floor(point.x / pitch);
    let best: Occurrence | undefined;
    let bestDistance = Infinity;
    // Nearby first: a few screens around the point.
    for (let c = centre - 6; c <= centre + 6; c++) {
      const column = this.column(c);
      for (const row of column.rowsIn(point.y - 4000, point.y + 4000)) {
        if (this.itemAt(c, row) !== index) continue;
        const o = this.occurrence(c, row);
        const d = Math.hypot(o.x + o.width / 2 - point.x, o.y + o.height / 2 - point.y);
        if (d < bestDistance) [best, bestDistance] = [o, d];
      }
    }
    if (best) return best;
    // Otherwise walk the nearest column: every item appears within count + BLOCK rows.
    const row0 = this.column(centre).rowsIn(point.y, point.y + 1)[0] ?? 0;
    for (let i = 0; i <= this.count + BLOCK; i++) {
      for (const row of [row0 + i, row0 - i]) if (this.itemAt(centre, row) === index) return this.occurrence(centre, row);
    }
    return undefined;
  }

  private column(c: number): Column {
    let column = this.columns.get(c);
    if (!column) {
      column = new Column(c, this);
      this.columns.set(c, column);
    }
    return column;
  }

  /** Internal: tile height of the item at a position. */
  heightAt(column: number, row: number): number {
    return Math.round(this.columnWidth * (this.ratios[this.itemAt(column, row)] ?? 1));
  }
}

/** One column's row tops, computed lazily outward from row 0 in both directions. */
class Column {
  private readonly below: number[] = []; // tops of rows 0, 1, 2, …
  private readonly above: number[] = []; // tops of rows -1, -2, …
  private readonly index: number;
  private readonly canvas: ArchiveCanvas;

  constructor(index: number, canvas: ArchiveCanvas) {
    this.index = index;
    this.canvas = canvas;
    // Columns start at different heights so rows never line up.
    this.below.push(Math.round(random(index, 0x51) * canvas.columnWidth * 0.7));
  }

  height(row: number): number {
    return this.canvas.heightAt(this.index, row);
  }

  top(row: number): number {
    this.extendTo(row);
    return row >= 0 ? this.below[row]! : this.above[-row - 1]!;
  }

  /** Rows overlapping [from, to), in order. */
  rowsIn(from: number, to: number): number[] {
    const rows: number[] = [];
    let row = 0;
    // Walk to the first row ending after `from`, then collect until a row starts at or after `to`.
    while (this.top(row) + this.height(row) > from) row--;
    while (this.top(row) + this.height(row) <= from) row++;
    for (; this.top(row) < to; row++) rows.push(row);
    return rows;
  }

  private gapAfter(row: number): number {
    // Gaps vary a little, for a looser rhythm.
    return this.canvas.gap + Math.round(random(this.index, row) * this.canvas.gap * 0.6);
  }

  private extendTo(row: number) {
    while (row >= this.below.length) {
      const last = this.below.length - 1;
      this.below.push(this.below[last]! + this.height(last) + this.gapAfter(last));
    }
    while (row < -this.above.length) {
      const next = -this.above.length - 1;
      const prevTop = next === -1 ? this.below[0]! : this.above[this.above.length - 1]!;
      this.above.push(prevTop - this.gapAfter(next) - this.height(next));
    }
  }
}

// ---------------------------------------------------------------------------
// Focus and camera on the canvas
// ---------------------------------------------------------------------------

export type FocusLayout = {
  /** The focused item's rectangle. */
  focus: Rect;
  /** Where any occurrence sits while focused (its normal rectangle when it isn't moved). */
  place: (o: Occurrence) => Rect;
  /** The furthest anything moves: the canvas looks this much beyond the view for things moving into it. */
  reach: number;
};

/**
 * Makes room for a focused item by letting the field flow around it — every
 * item stays visible, nothing overlaps, and nothing leaves a hole.
 *
 * The canvas is made of columns, so the room is made the way columns can
 * give it, as whole moves that never collide:
 *
 *   - The focus takes the span of k whole columns nearest its size (k ≥ 1),
 *     centred on its own column (for an even k, it reaches into the column
 *     on its right).
 *   - Vertically, each of those columns parts around it: everything above
 *     slides up and everything below slides down, as one piece, until it is
 *     exactly a gap clear of the focus (or closes in, if the focus is shorter
 *     than what was there).
 *   - Horizontally, if the focus is wider than its span, every column to its
 *     left slides left and every column to its right slides right, by half
 *     the overflow; if it is narrower, it sits centred in its span.
 *
 * Moves are uniform along each column, so far away nothing changes shape; the
 * room shows only as a little extra breathing space along the focus's columns
 * (or beside the focus), never as a missing item.
 *
 * Deterministic: same input, same result. Pure.
 */
export function packAroundFocus(canvas: ArchiveCanvas, focused: Occurrence, size: { width: number; height: number }): FocusLayout {
  const { columnWidth, gap } = canvas;
  const pitch = columnWidth + gap;
  const k = Math.max(1, Math.round((size.width + gap) / pitch));
  const first = focused.column - Math.floor((k - 1) / 2);
  const last = first + k - 1;
  const spanX = canvas.columnX(first);
  const spanWidth = k * columnWidth + (k - 1) * gap;
  const shiftX = Math.max(0, Math.ceil((size.width - spanWidth) / 2));

  // The focus: centred on its span horizontally, grown about its own centre vertically.
  const focus: Rect = {
    x: Math.round(spanX + (spanWidth - size.width) / 2),
    y: Math.round(focused.y - (size.height - focused.height) / 2),
    width: size.width,
    height: size.height,
  };
  const centreY = focus.y + focus.height / 2;

  // Per spanned column: the first row below the focus, and how far each side slides.
  const parts = new Map<number, { split: number; up: number; down: number }>();
  for (let column = first; column <= last; column++) {
    let split: number;
    let above: number;
    let below: number;
    if (column === focused.column) {
      // The focused item itself leaves the column; the focus takes its place.
      split = focused.row + 1;
      above = focused.row - 1;
      below = focused.row + 1;
    } else {
      // The first row whose centre lies below the focus's centre (a band a few tiles tall always holds it).
      const band = 4 * columnWidth;
      const rows = canvas.occurrencesIn({ x: canvas.columnX(column), y: centreY - band, width: 1, height: 2 * band });
      split = (rows.find((o) => o.y + o.height / 2 >= centreY) ?? rows.at(-1)!).row;
      above = split - 1;
      below = split;
    }
    const a = canvas.occurrence(column, above);
    const b = canvas.occurrence(column, below);
    // Exactly a gap clear of the focus: apart when it is taller than what was there, together when it is shorter.
    parts.set(column, { split, up: a.y + a.height + gap - focus.y, down: focus.y + focus.height + gap - b.y });
  }

  const place = (o: Occurrence): Rect => {
    const rect = { x: o.x, y: o.y, width: o.width, height: o.height };
    if (o.column < first) rect.x -= shiftX;
    else if (o.column > last) rect.x += shiftX;
    else {
      const part = parts.get(o.column)!;
      rect.y += o.row < part.split ? -part.up : part.down;
    }
    return rect;
  };
  const reach = Math.max(shiftX, ...[...parts.values()].flatMap((p) => [Math.abs(p.up), Math.abs(p.down)]));
  return { focus, place, reach };
}

export type Camera = { x: number; y: number; zoom: number };

/**
 * The camera that brings a canvas rectangle into the focus area: a little
 * left of centre on wide screens (centred on narrow ones), a little above the
 * middle of the space below the top chrome. The camera is the canvas point at
 * the viewport's top-left corner.
 */
export function focusCamera(rect: Rect, viewport: { width: number; height: number; top: number }): Camera {
  const lean = viewport.width > 900 ? viewport.width * 0.04 : 0;
  const left = (viewport.width - rect.width) / 2 - lean;
  const room = viewport.height - viewport.top;
  const top = viewport.top + Math.max(8, (room - rect.height) * 0.4);
  return { x: Math.round(rect.x - left), y: Math.round(rect.y - top), zoom: 1 };
}

// ---------------------------------------------------------------------------

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Deterministic pseudo-random number in [0, 1) for two integers. */
function random(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const permutations = new Map<string, number[]>();

/** A deterministic shuffle of 0…BLOCK-1 for one block of one column. */
function permutation(column: number, block: number): number[] {
  const key = `${column}:${block}`;
  let p = permutations.get(key);
  if (!p) {
    p = Array.from({ length: BLOCK }, (_, i) => i);
    for (let i = BLOCK - 1; i > 0; i--) {
      const j = Math.floor(random(column * 7919 + block, i) * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    if (permutations.size > 20_000) permutations.clear();
    permutations.set(key, p);
  }
  return p;
}
