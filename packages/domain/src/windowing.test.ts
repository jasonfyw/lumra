import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeJustifiedLayout, layoutConfigForWidth } from './justified-layout';
import { getVisibleRows, rowIndexForItem } from './windowing';

const items = Array.from({ length: 2_000 }, (_, i) => ({
  id: `m${i}`,
  width: i % 4 === 0 ? 2000 : 3000,
  height: i % 4 === 0 ? 3000 : 2000,
}));
const layout = computeJustifiedLayout(items, layoutConfigForWidth(1280));

describe('getVisibleRows', () => {
  it('renders only rows intersecting the viewport plus overscan', () => {
    const win = getVisibleRows(layout, { scrollTop: 10_000, viewportHeight: 900, overscanPx: 400 });
    expect(win.totalHeight).toBe(layout.totalHeight);
    const rendered = layout.rows.slice(win.startRow, win.endRow);
    expect(rendered.length).toBeGreaterThan(0);
    expect(win.offsetTop).toBe(rendered[0]!.y);
    for (const row of rendered) {
      expect(row.y + row.height).toBeGreaterThan(10_000 - 400);
      expect(row.y).toBeLessThan(10_000 + 900 + 400);
    }
    const before = layout.rows[win.startRow - 1];
    const after = layout.rows[win.endRow];
    if (before) expect(before.y + before.height).toBeLessThanOrEqual(10_000 - 400);
    if (after) expect(after.y).toBeGreaterThanOrEqual(10_000 + 900 + 400);
  });

  it('keeps the rendered item count bounded for 2,000 items at any scroll position', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2_000, max: layout.totalHeight + 2_000 }), (scrollTop) => {
        const win = getVisibleRows(layout, { scrollTop, viewportHeight: 1000, overscanPx: 800 });
        const count = layout.rows
          .slice(win.startRow, win.endRow)
          .reduce((n, row) => n + row.items.length, 0);
        expect(count).toBeLessThan(100);
        expect(win.startRow).toBeLessThanOrEqual(win.endRow);
      }),
    );
  });

  it('starts at the first row at the top and returns nothing past the end', () => {
    expect(getVisibleRows(layout, { scrollTop: 0, viewportHeight: 800 }).startRow).toBe(0);
    const past = getVisibleRows(layout, {
      scrollTop: layout.totalHeight + 5_000,
      viewportHeight: 800,
      overscanPx: 0,
    });
    expect(past.startRow).toBe(past.endRow);
    expect(past.offsetTop).toBe(layout.totalHeight);
  });

  it('handles an empty layout', () => {
    expect(
      getVisibleRows({ rows: [], totalHeight: 0 }, { scrollTop: 0, viewportHeight: 500 }),
    ).toEqual({ startRow: 0, endRow: 0, totalHeight: 0, offsetTop: 0 });
  });
});

describe('rowIndexForItem', () => {
  it('finds the row containing an item', () => {
    for (const index of [0, 1, 999, 1_999]) {
      const row = layout.rows[rowIndexForItem(layout, index)]!;
      expect(row.items.some((b) => b.index === index)).toBe(true);
    }
    expect(rowIndexForItem(layout, 2_000)).toBe(-1);
  });
});
