import { JUSTIFIED_LAYOUT } from '@lumra/config';
import type { JustifiedLayout, LayoutRow } from './justified-layout';

/**
 * Row windowing for the justified grid (G-04, T17): the UI renders only rows intersecting
 * the viewport ± overscan, inside a spacer of `totalHeight`, so DOM size stays bounded even
 * for 2,000 items. Rows are sorted by `y`, so lookup is a binary search.
 */
export interface WindowOptions {
  /** Scroll offset relative to the top of the grid (may be negative above the grid). */
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
}

export interface VisibleWindow {
  /** First row to render (inclusive). */
  startRow: number;
  /** Row after the last one to render (exclusive); `startRow === endRow` means none. */
  endRow: number;
  totalHeight: number;
  /** Space above the first rendered row, for a top spacer or translateY. */
  offsetTop: number;
}

type RowLike = Pick<LayoutRow, 'y' | 'height'>;

export function getVisibleRows(
  layout: Pick<JustifiedLayout, 'rows' | 'totalHeight'>,
  options: WindowOptions,
): VisibleWindow {
  const { rows, totalHeight } = layout;
  const overscan = Math.max(0, options.overscanPx ?? JUSTIFIED_LAYOUT.overscanPx);
  const top = options.scrollTop - overscan;
  const bottom = options.scrollTop + Math.max(0, options.viewportHeight) + overscan;

  // First row whose bottom edge is below `top`.
  const startRow = lowerBound(rows, (row) => row.y + row.height > top);
  // First row whose top edge is at or below `bottom`.
  const endRow = Math.max(
    startRow,
    lowerBound(rows, (row) => row.y >= bottom),
  );
  const offsetTop = startRow < rows.length ? (rows[startRow] as RowLike).y : totalHeight;
  return { startRow, endRow, totalHeight, offsetTop };
}

/** Index of the first row satisfying a predicate that is monotone (false…true) over rows. */
function lowerBound(rows: readonly RowLike[], predicate: (row: RowLike) => boolean): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (predicate(rows[mid] as RowLike)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Row containing item `index` (e.g. to scroll the lightbox's current item into view). */
export function rowIndexForItem(layout: Pick<JustifiedLayout, 'rows'>, itemIndex: number): number {
  const rows = layout.rows;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const items = (rows[mid] as LayoutRow).items;
    const first = items[0]?.index ?? 0;
    const last = items[items.length - 1]?.index ?? -1;
    if (itemIndex < first) hi = mid - 1;
    else if (itemIndex > last) lo = mid + 1;
    else return mid;
  }
  return -1;
}
