import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArchiveCanvas, focusCamera, packAroundFocus, type FocusLayout, type Occurrence, type Rect } from "./canvas-layout.ts";

const ratios = (n: number) => Array.from({ length: n }, (_, i) => [1.25, 1, 0.8, 1.6, 0.6][i % 5]!);
const canvas = (n: number) => new ArchiveCanvas({ ratios: ratios(n), columnWidth: 200, gap: 12 });
const overlapsVertically = (a: Occurrence, b: Occurrence) => a.y < b.y + b.height && b.y < a.y + a.height;

describe("ArchiveCanvas", () => {
  it("is deterministic and unbounded in every direction", () => {
    const view = { x: -30_000, y: -50_000, width: 1400, height: 900 };
    const a = canvas(500).occurrencesIn(view);
    const b = canvas(500).occurrencesIn(view);
    assert.ok(a.length > 10);
    assert.deepEqual(a, b);
  });

  it("covers a window without gaps or overlaps within a column", () => {
    const occurrences = canvas(500).occurrencesIn({ x: 0, y: 0, width: 1000, height: 3000 });
    const byColumn = Map.groupBy(occurrences, (o) => o.column);
    assert.equal(byColumn.size, 5);
    for (const column of byColumn.values()) {
      for (let i = 1; i < column.length; i++) {
        const gap = column[i]!.y - (column[i - 1]!.y + column[i - 1]!.height);
        assert.ok(gap >= 12 && gap <= 20, `gap ${gap}`);
      }
      assert.ok(column[0]!.y <= 20 && column.at(-1)!.y + column.at(-1)!.height >= 3000 - 20); // an edge may fall in a gap
    }
  });

  it("starts with the archive's first items around the origin and repeats beyond its end", () => {
    const c = canvas(40);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((row) => c.itemAt(0, row)).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7]);
    const seen = new Set(Array.from({ length: 400 }, (_, row) => c.itemAt(0, row)));
    assert.equal(seen.size, 40); // every item, many times over
  });

  it("never shows an item twice in a row in a column", () => {
    for (const n of [2, 3, 5, 15, 16, 40, 5150]) {
      const c = canvas(n);
      for (let col = -5; col <= 5; col++) for (let row = -300; row < 300; row++) assert.notEqual(c.itemAt(col, row), c.itemAt(col, row + 1), `n=${n}`);
    }
  });

  it("keeps copies of an item out of neighbouring columns (large archives)", () => {
    const occurrences = canvas(5150).occurrencesIn({ x: -2000, y: -3000, width: 6000, height: 9000 });
    for (const a of occurrences) {
      for (const b of occurrences) {
        if (b.column === a.column + 1 && b.index === a.index) assert.ok(!overlapsVertically(a, b));
      }
    }
  });

  it("finds the occurrence of an item nearest a point, even far away", () => {
    const c = canvas(5150);
    const near = c.findOccurrence(c.itemAt(3, 2), { x: 3 * 212, y: 0 });
    assert.deepEqual([near?.column, near?.row], [3, 2]);
    const far = c.findOccurrence(4000, { x: 0, y: 0 });
    assert.equal(far?.index, 4000);
    assert.equal(c.findOccurrence(9999, { x: 0, y: 0 }), undefined);
  });
});

/** Closer than `gap` (overlapping counts), with half a pixel of tolerance for rounding. */
const tooClose = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.width + gap - 0.5 && b.x < a.x + a.width + gap - 0.5 && a.y < b.y + b.height + gap - 0.5 && b.y < a.y + a.height + gap - 0.5;

/** Everything within `margin` of the focus, where it sits while focused (the focus in place of its own tile). */
const settled = (c: ArchiveCanvas, focused: Occurrence, layout: FocusLayout, margin = 2500) => {
  const f = layout.focus;
  const around = c.occurrencesIn({ x: f.x - margin, y: f.y - margin, width: f.width + 2 * margin, height: f.height + 2 * margin });
  return around.map((o) => ({ o, rect: o.id === focused.id ? f : layout.place(o) }));
};

describe("focus: the field flows around it", () => {
  const cases = [[0, 0], [2, 3], [-4, 11], [7, -6], [-6, -6], [6, 9]] as const;
  const shapes = [
    { columnWidth: 222, gap: 20, size: (o: Occurrence) => ({ width: 333, height: Math.round(o.height * 1.5) + 100 }) }, // ~1.5 columns
    { columnWidth: 222, gap: 20, size: (o: Occurrence) => ({ width: 266, height: o.height + 104 }) }, // tall media, narrowed
    { columnWidth: 160, gap: 12, size: () => ({ width: 320, height: 520 }) }, // two columns' worth (phone)
    { columnWidth: 300, gap: 20, size: () => ({ width: 700, height: 300 }) }, // wide and short
  ];

  it("never overlaps and keeps the minimum gap everywhere, with every item still shown", () => {
    for (const shape of shapes) {
      const c = new ArchiveCanvas({ ratios: ratios(5150), columnWidth: shape.columnWidth, gap: shape.gap });
      for (const [column, row] of cases) {
        const focused = c.occurrence(column, row);
        const layout = packAroundFocus(c, focused, shape.size(focused));
        const all = settled(c, focused, layout);
        for (const { o, rect } of all) if (o.id !== focused.id) assert.deepEqual([rect.width, rect.height], [o.width, o.height], "nothing shrinks");
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++)
            assert.ok(!tooClose(all[i]!.rect, all[j]!.rect, shape.gap), `${all[i]!.o.id} and ${all[j]!.o.id} collide (focus ${column}:${row}, width ${shape.columnWidth})`);
      }
    }
  });

  it("leaves no hole: neighbours settle against the focus on every side", () => {
    for (const shape of shapes) {
      const c = new ArchiveCanvas({ ratios: ratios(5150), columnWidth: shape.columnWidth, gap: shape.gap });
      const pitch = shape.columnWidth + shape.gap;
      for (const [column, row] of cases) {
        const focused = c.occurrence(column, row);
        const layout = packAroundFocus(c, focused, shape.size(focused));
        const f = layout.focus;
        const others = settled(c, focused, layout, 800).filter(({ o }) => o.id !== focused.id).map(({ rect }) => rect);
        const overlapsX = (r: Rect) => r.x < f.x + f.width && f.x < r.x + r.width;
        const overlapsY = (r: Rect) => r.y < f.y + f.height && f.y < r.y + r.height;
        // Sideways: at most the gap plus half a column of breathing room (when the focus is narrower than its span).
        const side = shape.gap + pitch / 2;
        assert.ok(others.some((r) => overlapsY(r) && f.x - (r.x + r.width) <= side), "left");
        assert.ok(others.some((r) => overlapsY(r) && r.x - (f.x + f.width) <= side), "right");
        // Above and below, the parted columns close up to exactly the gap.
        assert.ok(others.some((r) => overlapsX(r) && Math.abs(f.y - (r.y + r.height) - shape.gap) <= 1), "above");
        assert.ok(others.some((r) => overlapsX(r) && Math.abs(r.y - (f.y + f.height) - shape.gap) <= 1), "below");
      }
    }
  });

  it("moves whole columns as one piece, so far from the focus nothing changes shape", () => {
    const c = new ArchiveCanvas({ ratios: ratios(5150), columnWidth: 222, gap: 20 });
    const focused = c.occurrence(2, 3);
    const layout = packAroundFocus(c, focused, { width: 333, height: 600 });
    const all = settled(c, focused, layout).filter(({ o }) => o.id !== focused.id);
    const byColumn = new Map<number, { o: Occurrence; rect: Rect }[]>();
    for (const a of all) byColumn.set(a.o.column, [...(byColumn.get(a.o.column) ?? []), a]);
    let parted = 0;
    for (const [column, list] of byColumn) {
      list.sort((a, b) => a.o.row - b.o.row);
      const dxs = new Set(list.map(({ o, rect }) => rect.x - o.x));
      assert.equal(dxs.size, 1, `column ${column} moves sideways as one piece`);
      const dys = list.map(({ o, rect }) => rect.y - o.y);
      // A column either stays put vertically or parts once (above slides up, below slides down).
      const changes = dys.filter((d, i) => i > 0 && d !== dys[i - 1]).length;
      assert.ok(changes <= 1, `column ${column} parts at most once`);
      if (changes === 1) parted++;
    }
    // About 1.5 columns wide: its own column parts; the others slide aside instead.
    assert.equal(parted, 1, "only the focus's own column parts around it");
    const wide = packAroundFocus(c, focused, { width: 470, height: 600 }); // two columns' worth: both part
    const partedWide = new Set(settled(c, focused, wide).filter(({ o, rect }) => o.id !== focused.id && rect.y !== o.y).map(({ o }) => o.column));
    assert.deepEqual([...partedWide].sort(), [2, 3]);
  });

  it("centres the focus on the columns it spans", () => {
    const c = new ArchiveCanvas({ ratios: ratios(500), columnWidth: 200, gap: 20 });
    const focused = c.occurrence(0, 0);
    // About one column wide: centred on its own column, the others slide aside by half the overflow.
    const one = packAroundFocus(c, focused, { width: 260, height: 300 });
    assert.equal(one.focus.x, -30);
    assert.equal(one.place(c.occurrence(1, 0)).x, 220 + 30);
    assert.equal(one.place(c.occurrence(-1, 0)).x, -220 - 30);
    // Two columns' worth: it takes its own column and the next, centred on both; nothing slides sideways.
    const two = packAroundFocus(c, focused, { width: 400, height: 300 });
    assert.equal(two.focus.x, 10);
    assert.equal(two.place(c.occurrence(2, 0)).x, 440);
  });

  it("is deterministic", () => {
    const c = new ArchiveCanvas({ ratios: ratios(500), columnWidth: 222, gap: 20 });
    const focused = c.occurrence(3, -2);
    const a = packAroundFocus(c, focused, { width: 333, height: 500 });
    const b = packAroundFocus(c, focused, { width: 333, height: 500 });
    assert.deepEqual(a.focus, b.focus);
    assert.equal(a.reach, b.reach);
    for (const o of c.occurrencesIn({ x: -1000, y: -1500, width: 3000, height: 3000 })) assert.deepEqual(a.place(o), b.place(o));
  });
});

describe("focus on the archive canvas", () => {
  it("points the camera so the focus sits a little left of centre and below the top chrome", () => {
    const rect = { x: 5000, y: -3000, width: 300, height: 500 };
    const camera = focusCamera(rect, { width: 1440, height: 900, top: 140 });
    assert.equal(rect.x - camera.x, Math.round((1440 - 300) / 2 - 1440 * 0.04));
    assert.equal(rect.y - camera.y, 140 + Math.round((760 - 500) * 0.4));
    const phone = focusCamera(rect, { width: 390, height: 844, top: 120 });
    assert.equal(rect.x - phone.x, 45); // centred
  });
});
