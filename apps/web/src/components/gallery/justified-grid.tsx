'use client';

import type { PublicMediaItem } from '@lumra/contracts';
import {
  computeJustifiedLayout,
  getVisibleRows,
  layoutConfigForWidth,
  rowIndexForItem,
  type JustifiedLayout,
  type LayoutBox,
} from '@lumra/domain';
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { altText, devicePixelRatio, itemLabel, responsiveImageFor } from './media';

export interface JustifiedGridHandle {
  /**
   * Scrolls the window so the row holding item `index` is in view (no-op when it already is),
   * and optionally moves focus to that tile once it is rendered.
   */
  revealItem(index: number, options?: { focus?: boolean }): void;
}

export interface JustifiedGridProps {
  items: readonly PublicMediaItem[];
  /** Called with the item index when a tile is activated (click, Enter, Space). */
  onOpen(index: number): void;
  /** Accessible name of the photo list. */
  label?: string;
  ref?: Ref<JustifiedGridHandle>;
}

interface RowRange {
  start: number;
  end: number;
}

const EMPTY_RANGE: RowRange = { start: 0, end: 0 };

// Before hydration measures the width, keep the grid's space reserved below the hero.
const UNMEASURED_MIN_HEIGHT = '100svh';

/**
 * Justified, windowed photo grid (PRD §4, G-04, T17).
 *
 * Rows come from `computeJustifiedLayout` at the measured container width; only rows that
 * intersect the viewport ± overscan are in the DOM (`getVisibleRows` against window scroll),
 * so 2,000 items keep a bounded node count. Tiles are absolutely positioned inside a spacer of
 * the full layout height with explicit sizes, so loading images never shift layout.
 */
export function JustifiedGrid({ items, onOpen, label = 'Photos', ref }: JustifiedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dpr, setDpr] = useState(1);
  const [range, setRange] = useState<RowRange>(EMPTY_RANGE);
  const [focusTick, setFocusTick] = useState(0);
  const pendingFocus = useRef<number | null>(null);

  const layoutItems = useMemo(
    () => items.map((item) => ({ id: item.id, width: item.width, height: item.height })),
    [items],
  );
  const layout = useMemo<JustifiedLayout>(
    () => computeJustifiedLayout(layoutItems, layoutConfigForWidth(width)),
    [layoutItems, width],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** Recomputes the rendered row window from the grid's current position in the viewport. */
  const updateRange = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const visible = getVisibleRows(layoutRef.current, {
      scrollTop: -el.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    });
    setRange((prev) =>
      prev.start === visible.startRow && prev.end === visible.endRow
        ? prev
        : { start: visible.startRow, end: visible.endRow },
    );
  }, []);

  // Measure width synchronously before paint, then track it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    setDpr(devicePixelRatio());
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    updateRange();
  }, [layout, updateRange]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateRange();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updateRange]);

  useImperativeHandle(
    ref,
    () => ({
      revealItem(index, options) {
        const el = containerRef.current;
        const current = layoutRef.current;
        const rowIndex = rowIndexForItem(current, index);
        const row = current.rows[rowIndex];
        if (!el || !row) return;
        const rowTop = el.getBoundingClientRect().top + row.y;
        const viewport = window.innerHeight;
        if (rowTop < 0 || rowTop + row.height > viewport) {
          const offset = Math.max(0, (viewport - row.height) / 2);
          window.scrollTo({ top: window.scrollY + rowTop - offset, behavior: 'instant' });
        }
        updateRange();
        if (options?.focus) {
          pendingFocus.current = index;
          setFocusTick((tick) => tick + 1);
        }
      },
    }),
    [updateRange],
  );

  // Deliver a requested focus once the target tile is in the DOM.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const tile = containerRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (tile) {
      pendingFocus.current = null;
      tile.focus({ preventScroll: true });
    }
  }, [focusTick, range]);

  const boxes: LayoutBox[] = [];
  for (let r = range.start; r < range.end && r < layout.rows.length; r++) {
    boxes.push(...(layout.rows[r]?.items ?? []));
  }

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={width === 0 ? { minHeight: UNMEASURED_MIN_HEIGHT } : undefined}
    >
      <ul
        aria-label={label}
        className="relative m-0 list-none p-0"
        style={{ height: layout.totalHeight }}
      >
        {boxes.map((box) => {
          const item = items[box.index] as PublicMediaItem;
          return (
            <Tile
              key={item.id}
              item={item}
              box={box}
              total={items.length}
              dpr={dpr}
              onOpen={onOpen}
            />
          );
        })}
      </ul>
    </div>
  );
}

interface TileProps {
  item: PublicMediaItem;
  box: LayoutBox;
  total: number;
  dpr: number;
  onOpen(index: number): void;
}

const Tile = memo(function Tile({ item, box, total, dpr, onOpen }: TileProps) {
  const image = responsiveImageFor(item, box.width, dpr);
  return (
    <li
      aria-setsize={total}
      aria-posinset={box.index + 1}
      className="absolute focus-within:z-10"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <button
        type="button"
        data-gallery-tile=""
        data-index={box.index}
        data-status={item.status}
        aria-label={item.status === 'ready' ? `Open ${altText(item)}` : itemLabel(item)}
        onClick={() => onOpen(box.index)}
        className="relative block h-full w-full cursor-zoom-in overflow-hidden bg-[var(--color-surface)] p-0"
      >
        {image ? (
          // Gateway URLs with explicit srcset/sizes; next/image would proxy media through Vercel.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.src}
            srcSet={image.srcSet}
            sizes={image.sizes}
            width={box.width}
            height={box.height}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={(event) => {
              event.currentTarget.dataset.loaded = '';
            }}
            className="block h-full w-full object-cover opacity-0 transition-opacity duration-[var(--duration-base)] ease-[var(--ease-standard)] data-[loaded]:opacity-100"
          />
        ) : (
          <PlaceholderContent status={item.status} />
        )}
      </button>
    </li>
  );
});

function PlaceholderContent({ status }: { status: PublicMediaItem['status'] }) {
  if (status === 'pending') {
    return (
      <span
        aria-hidden="true"
        className="relative flex h-full w-full items-center justify-center bg-[var(--color-surface)] text-xs text-[var(--color-ink-muted)]"
      >
        <span className="absolute inset-0 bg-[var(--color-line)] opacity-60 motion-safe:animate-pulse" />
        <span className="relative rounded-full bg-[var(--color-canvas)] px-2 py-1">
          Processing…
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-full w-full items-center justify-center border border-[var(--color-line)] bg-[var(--color-surface)] text-xs text-[var(--color-ink-muted)]"
    >
      Unavailable
    </span>
  );
}
