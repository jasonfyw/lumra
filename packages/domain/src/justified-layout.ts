import { JUSTIFIED_LAYOUT } from '@lumra/config';

/**
 * Justified (row-based, no-crop) layout for the public gallery grid (PRD §4, T17).
 *
 * Items keep their intrinsic aspect ratio; each row is scaled so it spans the container
 * exactly. Rows aim for `targetRowHeight` and stay within `[minRowHeight, maxRowHeight]`
 * where the content allows. Pure and O(n): 2,000 items lay out in well under a millisecond
 * on desktop hardware, so it can re-run on every resize.
 *
 * Edge cases (never crop, never reorder):
 * - A very wide image (panorama) that would push a row below `minRowHeight` is placed on its
 *   own full-width row, even if that row is shorter than `minRowHeight`.
 * - If closing a row early would stretch it beyond `maxRowHeight` (e.g. one portrait followed
 *   by a panorama), the row is capped at `maxRowHeight` and left-aligned (`filled: false`).
 * - The last row is never stretched: it uses `targetRowHeight` and is left-aligned.
 */

const MIN_TILE_PX = 2;

export interface LayoutItemInput {
  id: string;
  /** Intrinsic pixel size; `null` for placeholders whose dimensions are not known yet. */
  width: number | null;
  height: number | null;
}

export interface JustifiedLayoutOptions {
  containerWidth: number;
  targetRowHeight: number;
  minRowHeight: number;
  maxRowHeight: number;
  /** Horizontal and vertical spacing between tiles, in px. */
  gap: number;
  /** Aspect ratio (w/h) for items without valid dimensions. */
  defaultAspectRatio?: number;
}

export interface LayoutBox {
  id: string;
  /** Position of the item in the input array. */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutRow {
  index: number;
  y: number;
  height: number;
  /** True when the row spans exactly `containerWidth`. */
  filled: boolean;
  items: LayoutBox[];
}

export interface JustifiedLayout {
  containerWidth: number;
  totalHeight: number;
  itemCount: number;
  rows: LayoutRow[];
}

/** Breakpoint-aware defaults (desktop vs mobile row heights) for a container width. */
export function layoutConfigForWidth(containerWidth: number): JustifiedLayoutOptions {
  const preset =
    containerWidth < JUSTIFIED_LAYOUT.mobileBreakpointPx
      ? JUSTIFIED_LAYOUT.mobile
      : JUSTIFIED_LAYOUT.desktop;
  return {
    containerWidth,
    ...preset,
    defaultAspectRatio: JUSTIFIED_LAYOUT.defaultAspectRatio,
  };
}

/** Aspect ratio (w/h) of an item, falling back to the default for missing/invalid sizes. */
export function itemAspectRatio(
  item: Pick<LayoutItemInput, 'width' | 'height'>,
  defaultAspectRatio: number = JUSTIFIED_LAYOUT.defaultAspectRatio,
): number {
  const { width, height } = item;
  if (width === null || height === null) return defaultAspectRatio;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return defaultAspectRatio;
  }
  return width / height;
}

export function computeJustifiedLayout(
  items: readonly LayoutItemInput[],
  options: JustifiedLayoutOptions,
): JustifiedLayout {
  const containerWidth = Math.max(0, Math.floor(options.containerWidth));
  const gap = Math.max(0, Math.round(options.gap));
  const target = options.targetRowHeight;
  const minH = Math.min(options.minRowHeight, target);
  const maxH = Math.max(options.maxRowHeight, target);
  const fallback = options.defaultAspectRatio ?? JUSTIFIED_LAYOUT.defaultAspectRatio;

  const rows: LayoutRow[] = [];
  if (containerWidth === 0 || items.length === 0) {
    return { containerWidth, totalHeight: 0, itemCount: items.length, rows };
  }

  const aspects = new Float64Array(items.length);
  for (let i = 0; i < items.length; i++) {
    aspects[i] = itemAspectRatio(items[i] as LayoutItemInput, fallback);
  }

  let y = 0;
  const fillHeight = (count: number, aspectSum: number) =>
    Math.max(1, containerWidth - gap * (count - 1)) / aspectSum;

  const emit = (start: number, end: number, height: number, fill: boolean) => {
    const row = buildRow(items, aspects, start, end, height, fill, containerWidth, gap, y);
    row.index = rows.length;
    rows.push(row);
    y += row.height + gap;
  };

  let start = 0;
  let aspectSum = 0;
  for (let i = 0; i < items.length; i++) {
    const aspect = aspects[i] as number;
    aspectSum += aspect;
    const count = i - start + 1;
    const withH = fillHeight(count, aspectSum);
    // Pathologically thin images could otherwise pack a row past 1 px per tile.
    const crowded = count > 1 && containerWidth - gap * (count - 1) < MIN_TILE_PX * count;
    if (withH > target && !crowded) continue;

    if (count === 1) {
      // A single item already reaches the target height alone (wide image): own row.
      emit(start, i + 1, withH, true);
      start = i + 1;
      aspectSum = 0;
      continue;
    }

    const withoutH = fillHeight(count - 1, aspectSum - aspect);
    const withOk = withH >= minH;
    const withoutOk = withoutH <= maxH;
    const takeItem = !crowded && withOk && (!withoutOk || target - withH <= withoutH - target);

    if (takeItem) {
      emit(start, i + 1, withH, true);
      start = i + 1;
      aspectSum = 0;
    } else {
      // Close the row before this item; it starts the next row.
      if (withoutOk) emit(start, i, withoutH, true);
      else emit(start, i, maxH, false);
      start = i;
      aspectSum = aspect;
      const aloneH = fillHeight(1, aspect);
      if (aloneH <= target) {
        emit(i, i + 1, aloneH, true);
        start = i + 1;
        aspectSum = 0;
      }
    }
  }
  if (start < items.length) emit(start, items.length, target, false);

  return { containerWidth, totalHeight: Math.max(0, y - gap), itemCount: items.length, rows };
}

function buildRow(
  items: readonly LayoutItemInput[],
  aspects: Float64Array,
  start: number,
  end: number,
  exactHeight: number,
  fill: boolean,
  containerWidth: number,
  gap: number,
  y: number,
): LayoutRow {
  const height = Math.max(1, Math.round(exactHeight));
  const boxes: LayoutBox[] = [];
  if (fill) {
    const widths = distributeWidths(aspects, start, end, exactHeight, containerWidth, gap);
    let x = 0;
    for (let i = start; i < end; i++) {
      const width = widths[i - start] as number;
      boxes.push(box(items, i, x, y, width, height));
      x += width + gap;
    }
  } else {
    let x = 0;
    let aspectSum = 0;
    for (let i = start; i < end; i++) {
      const width = Math.max(1, Math.round((aspects[i] as number) * height));
      boxes.push(box(items, i, x, y, width, height));
      x += width + gap;
      aspectSum += aspects[i] as number;
    }
    // Rounding can push a nearly-full unstretched row past the edge; justify it instead.
    if (x - gap > containerWidth) {
      const fillHeight = (containerWidth - gap * (end - start - 1)) / aspectSum;
      return buildRow(items, aspects, start, end, fillHeight, true, containerWidth, gap, y);
    }
  }
  const last = boxes[boxes.length - 1];
  const filled = fill || (last !== undefined && last.x + last.width === containerWidth);
  return { index: 0, y, height, filled, items: boxes };
}

/**
 * Integer widths (each ≥ 1 px) summing exactly to the row's available width. Largest-remainder
 * rounding keeps every width within 1 px of `aspect × exactHeight`; only when sub-pixel tiles
 * are bumped to 1 px are the extra pixels taken back from the widest tiles.
 */
function distributeWidths(
  aspects: Float64Array,
  start: number,
  end: number,
  exactHeight: number,
  containerWidth: number,
  gap: number,
): number[] {
  const count = end - start;
  const available = containerWidth - gap * (count - 1);
  const widths: number[] = new Array<number>(count);
  const fractions: number[] = new Array<number>(count);
  let remaining = available;
  for (let j = 0; j < count; j++) {
    const exact = (aspects[start + j] as number) * exactHeight;
    const floor = Math.floor(exact);
    widths[j] = Math.max(1, floor);
    fractions[j] = floor >= 1 ? exact - floor : -1;
    remaining -= widths[j] as number;
  }
  if (remaining > 0) {
    const order = Array.from({ length: count }, (_, j) => j).sort(
      (p, q) => (fractions[q] as number) - (fractions[p] as number) || p - q,
    );
    for (let t = 0; remaining > 0; t++, remaining--) {
      const j = order[t % count] as number;
      widths[j] = (widths[j] as number) + 1;
    }
  }
  while (remaining < 0) {
    let widest = 0;
    for (let j = 1; j < count; j++)
      if ((widths[j] as number) > (widths[widest] as number)) widest = j;
    if ((widths[widest] as number) <= 1) break;
    widths[widest] = (widths[widest] as number) - 1;
    remaining++;
  }
  return widths;
}

function box(
  items: readonly LayoutItemInput[],
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
): LayoutBox {
  return { id: (items[index] as LayoutItemInput).id, index, x, y, width, height };
}
