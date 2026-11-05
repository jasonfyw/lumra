import { JUSTIFIED_LAYOUT } from '@lumra/config';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeJustifiedLayout,
  itemAspectRatio,
  layoutConfigForWidth,
  type JustifiedLayout,
  type LayoutBox,
  type LayoutItemInput,
} from './justified-layout';

const desktop = layoutConfigForWidth(1200);

/** Smallest max(|w - s·a|, |h - s|) over a few candidate scales: "no crop within ±1 px". */
function aspectErrorPx(box: LayoutBox, aspect: number): number {
  const candidates = [box.height, box.width / aspect, (box.width + box.height) / (aspect + 1)];
  return Math.min(
    ...candidates.map((s) => Math.max(Math.abs(box.width - s * aspect), Math.abs(box.height - s))),
  );
}

function assertInvariants(
  layout: JustifiedLayout,
  items: LayoutItemInput[],
  gap: number,
  aspectTolerancePx = 1,
) {
  const boxes = layout.rows.flatMap((r) => r.items);
  expect(boxes.map((b) => b.index)).toEqual(items.map((_, i) => i));
  let y = 0;
  layout.rows.forEach((row, r) => {
    expect(row.index).toBe(r);
    expect(row.y).toBe(y);
    let x = 0;
    for (const box of row.items) {
      for (const v of [box.x, box.y, box.width, box.height]) expect(Number.isInteger(v)).toBe(true);
      expect(box.x).toBe(x);
      expect(box.y).toBe(row.y);
      expect(box.height).toBe(row.height);
      expect(box.width).toBeGreaterThan(0);
      expect(box.id).toBe(items[box.index]!.id);
      expect(aspectErrorPx(box, itemAspectRatio(items[box.index]!))).toBeLessThanOrEqual(
        aspectTolerancePx,
      );
      x = box.x + box.width + gap;
    }
    const right = x - gap;
    expect(right).toBeLessThanOrEqual(layout.containerWidth);
    if (row.filled) expect(right).toBe(layout.containerWidth);
    y = row.y + row.height + gap;
  });
  expect(layout.totalHeight).toBe(layout.rows.length ? y - gap : 0);
}

const sized = (sizes: [number, number][]): LayoutItemInput[] =>
  sizes.map(([width, height], i) => ({ id: `m${i}`, width, height }));

/** Photos up to 90:1 / 1:90, plus placeholders without dimensions. */
const itemArb = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.tuple(fc.integer({ min: 100, max: 9000 }), fc.integer({ min: 100, max: 9000 })),
  },
  { weight: 1, arbitrary: fc.constant([null, null] as const) },
);
/** Pathological slivers (down to 1×9000 px). */
const extremeItemArb = fc.tuple(
  fc.integer({ min: 1, max: 9000 }),
  fc.integer({ min: 1, max: 9000 }),
);

describe('layoutConfigForWidth', () => {
  it('uses desktop and mobile presets around the breakpoint', () => {
    expect(layoutConfigForWidth(1200)).toMatchObject({
      containerWidth: 1200,
      targetRowHeight: 220,
      minRowHeight: 180,
      maxRowHeight: 280,
    });
    expect(layoutConfigForWidth(375)).toMatchObject({
      containerWidth: 375,
      targetRowHeight: 150,
      minRowHeight: 110,
      maxRowHeight: 190,
    });
    expect(layoutConfigForWidth(JUSTIFIED_LAYOUT.mobileBreakpointPx).targetRowHeight).toBe(220);
  });
});

describe('itemAspectRatio', () => {
  it('falls back to 3:2 for placeholders and invalid sizes', () => {
    expect(itemAspectRatio({ width: null, height: null })).toBe(1.5);
    expect(itemAspectRatio({ width: 100, height: 0 })).toBe(1.5);
    expect(itemAspectRatio({ width: Number.NaN, height: 10 })).toBe(1.5);
    expect(itemAspectRatio({ width: 400, height: 200 })).toBe(2);
  });
});

describe('computeJustifiedLayout', () => {
  it('returns an empty layout for no items or an unmeasured container', () => {
    expect(computeJustifiedLayout([], desktop)).toMatchObject({ rows: [], totalHeight: 0 });
    expect(computeJustifiedLayout(sized([[3, 2]]), { ...desktop, containerWidth: 0 }).rows).toEqual(
      [],
    );
  });

  it('justifies full rows within the desktop height band and leaves the last row unstretched', () => {
    const items = sized(
      Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? [2000, 3000] : [3000, 2000])),
    );
    const layout = computeJustifiedLayout(items, desktop);
    assertInvariants(layout, items, desktop.gap);
    const rows = layout.rows;
    for (const row of rows.slice(0, -1)) {
      expect(row.filled).toBe(true);
      expect(row.height).toBeGreaterThanOrEqual(180);
      expect(row.height).toBeLessThanOrEqual(280);
    }
    const last = rows[rows.length - 1]!;
    if (!last.filled) expect(last.height).toBe(220);
  });

  it('lays out placeholders with the default 3:2 aspect', () => {
    const items: LayoutItemInput[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      width: null,
      height: null,
    }));
    const layout = computeJustifiedLayout(items, desktop);
    assertInvariants(layout, items, desktop.gap);
    // 1200 px at 3:2: ~3.6 tiles per row at 220 px -> 4 tiles of ~197 px.
    expect(layout.rows[0]!.items).toHaveLength(4);
  });

  it('puts an extreme panorama on its own full-width row', () => {
    const items = sized([
      [3000, 2000],
      [3000, 2000],
      [3000, 2000],
      [20000, 1000], // 20:1
      [3000, 2000],
      [3000, 2000],
    ]);
    const layout = computeJustifiedLayout(items, desktop);
    assertInvariants(layout, items, desktop.gap);
    const panoRow = layout.rows.find((r) => r.items.some((b) => b.id === 'm3'))!;
    expect(panoRow.items).toHaveLength(1);
    expect(panoRow.items[0]!.width).toBe(1200);
    expect(panoRow.height).toBe(60);
  });

  it('caps a sparse row before a panorama at maxRowHeight instead of over-stretching', () => {
    const items = sized([
      [1000, 3000], // tall portrait alone would need ~1200/0.33 px of height
      [20000, 1000],
    ]);
    const layout = computeJustifiedLayout(items, desktop);
    assertInvariants(layout, items, desktop.gap);
    expect(layout.rows[0]).toMatchObject({ height: 280, filled: false });
    expect(layout.rows[1]!.items[0]!.width).toBe(1200);
  });

  it('handles very tall images without cropping', () => {
    const items = sized([
      [100, 5000],
      [3000, 2000],
      [100, 5000],
      [3000, 2000],
      [3000, 2000],
      [3000, 2000],
      [3000, 2000],
    ]);
    const layout = computeJustifiedLayout(items, desktop);
    assertInvariants(layout, items, desktop.gap);
  });

  it('keeps invariants for arbitrary inputs, widths and presets', () => {
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 120 }),
        fc.integer({ min: 200, max: 2600 }),
        (dims, width) => {
          const items = dims.map(([w, h], i) => ({ id: `m${i}`, width: w, height: h }));
          const config = layoutConfigForWidth(width);
          assertInvariants(computeJustifiedLayout(items, config), items, config.gap);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never overlaps or overflows even for pathological slivers', () => {
    fc.assert(
      fc.property(
        fc.array(extremeItemArb, { maxLength: 120 }),
        fc.integer({ min: 200, max: 2600 }),
        (dims, width) => {
          const items = dims.map(([w, h], i) => ({ id: `m${i}`, width: w, height: h }));
          const config = layoutConfigForWidth(width);
          // Sub-pixel tiles are bumped to 1 px, which may cost a neighbour one extra pixel.
          assertInvariants(computeJustifiedLayout(items, config), items, config.gap, 2);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is deterministic', () => {
    const items = sized(
      Array.from({ length: 50 }, (_, i) => [1000 + i * 37, 1000 + ((i * 53) % 900)]),
    );
    expect(computeJustifiedLayout(items, desktop)).toEqual(computeJustifiedLayout(items, desktop));
  });

  it('lays out 2,000 items in under 50 ms', () => {
    const items: LayoutItemInput[] = Array.from({ length: 2_000 }, (_, i) => ({
      id: `m${i}`,
      width: i % 7 === 0 ? null : 1000 + ((i * 7919) % 4000),
      height: i % 7 === 0 ? null : 1000 + ((i * 104729) % 3000),
    }));
    computeJustifiedLayout(items, desktop); // warm-up
    const start = performance.now();
    const layout = computeJustifiedLayout(items, desktop);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    assertInvariants(layout, items, desktop.gap);
  });
});
