'use client';

import { JUSTIFIED_LAYOUT } from '@lumra/config';
import type { PublicMediaItem } from '@lumra/contracts';
import { itemAspectRatio } from '@lumra/domain';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { altText, devicePixelRatio, itemLabel, responsiveImageFor } from './media';

export interface LightboxProps {
  items: readonly PublicMediaItem[];
  /** Index of the item on screen (controlled). */
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
}

/** Minimum horizontal travel (CSS px) for a swipe to navigate. */
export const SWIPE_THRESHOLD_PX = 50;

const HEADER_PX = 56;
const FOOTER_PX = 76;
/** Horizontal room reserved for the side buttons on wide screens. */
const SIDE_GUTTER_PX = 80;
const WIDE_VIEWPORT_PX = 768;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Viewport {
  width: number;
  height: number;
}

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Fullscreen photo viewer (PRD §4, FR-V03, T18): modal dialog with focus trap and restore,
 * Escape to close, Left/Right and swipe to navigate, ≥44 px controls, adjacent-image prefetch
 * once the current image has loaded, and "Download original" for ready items. Never advances
 * on its own. Motion uses the duration tokens and is disabled by `prefers-reduced-motion`.
 */
export function Lightbox({ items, index, onIndexChange, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const prefetched = useRef(new Set<string>());
  const titleId = useId();
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [dpr] = useState(devicePixelRatio);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  const item = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  // Initial focus, background scroll lock, focus restore on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      root.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          onClose();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          go(-1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          go(1);
          return;
        case 'Tab':
          trapFocus(event, dialogRef.current);
          return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [go, onClose]);

  // Keep focus inside the dialog when a focused control becomes disabled (e.g. Next at the end).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) closeRef.current?.focus();
  }, [index]);

  const box = item ? stageBox(item, viewport) : { width: 0, height: 0 };
  const image = item ? responsiveImageFor(item, box.width, dpr) : null;
  const currentReady = item?.status === 'ready';
  const currentLoaded = !currentReady || loadedId === item?.id;

  // Conservative prefetch: neighbours only, and only after the current image has loaded.
  useEffect(() => {
    if (!currentLoaded) return;
    for (const neighbour of [items[index + 1], items[index - 1]]) {
      if (!neighbour) continue;
      const next = responsiveImageFor(neighbour, stageBox(neighbour, viewport).width, dpr);
      if (!next || prefetched.current.has(next.src)) continue;
      prefetched.current.add(next.src);
      const img = new Image();
      img.decoding = 'async';
      img.sizes = next.sizes;
      img.srcset = next.srcSet;
      img.src = next.src;
    }
  }, [currentLoaded, index, items, viewport, dpr]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    swipeStart.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? 1 : -1);
    }
  };

  if (!item) return null;
  const label = itemLabel(item);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="lightbox"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--color-canvas)] motion-safe:animate-[lumra-fade-in_var(--duration-base)_var(--ease-standard)]"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-4 px-2 sm:px-4"
        style={{ height: HEADER_PX }}
      >
        <p aria-live="polite" className="px-2 text-sm text-[var(--color-ink-muted)] tabular-nums">
          {(index + 1).toLocaleString('en-US')} of {items.length.toLocaleString('en-US')}
        </p>
        <IconButton ref={closeRef} label="Close" onClick={onClose}>
          <path d="M6 6l12 12M18 6L6 18" />
        </IconButton>
      </div>

      <div
        data-testid="lightbox-stage"
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
      >
        {image ? (
          // Gateway URLs with explicit srcset/sizes; next/image would proxy media through Vercel.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={item.id}
            src={image.src}
            srcSet={image.srcSet}
            sizes={image.sizes}
            width={Math.round(box.width)}
            height={Math.round(box.height)}
            alt={altText(item)}
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedId(item.id)}
            className="block bg-[var(--color-surface)] object-contain opacity-0 transition-opacity duration-[var(--duration-slow)] ease-[var(--ease-standard)] data-[loaded]:opacity-100"
            data-loaded={loadedId === item.id ? '' : undefined}
            style={{ width: box.width, height: box.height }}
          />
        ) : (
          <div
            key={item.id}
            className="flex items-center justify-center bg-[var(--color-surface)] px-6 text-center text-sm text-[var(--color-ink-muted)]"
            style={{ width: box.width, height: box.height }}
          >
            {item.status === 'pending'
              ? 'This photo is still processing. Check back soon.'
              : 'This photo isn’t available.'}
          </div>
        )}

        <IconButton
          label="Previous photo"
          onClick={() => go(-1)}
          disabled={!hasPrev}
          className="absolute top-1/2 left-2 -translate-y-1/2 sm:left-4"
        >
          <path d="M15 5l-7 7 7 7" />
        </IconButton>
        <IconButton
          label="Next photo"
          onClick={() => go(1)}
          disabled={!hasNext}
          className="absolute top-1/2 right-2 -translate-y-1/2 sm:right-4"
        >
          <path d="M9 5l7 7-7 7" />
        </IconButton>
      </div>

      <div
        className="flex shrink-0 items-center justify-between gap-4 px-4"
        style={{ height: FOOTER_PX }}
      >
        <h2 id={titleId} className="min-w-0 truncate text-sm font-medium">
          {label}
        </h2>
        {currentReady && item.downloadUrl ? (
          <a
            href={item.downloadUrl}
            download
            className="inline-flex min-h-11 shrink-0 items-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 text-sm font-medium text-white"
          >
            Download original
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex min-h-11 shrink-0 cursor-not-allowed items-center rounded-[var(--radius-control)] border border-[var(--color-line)] px-4 text-sm font-medium text-[var(--color-ink-muted)]"
          >
            Download original
          </button>
        )}
      </div>
    </div>
  );
}

/** Size of the displayed image: the item's aspect ratio fitted into the stage. */
function stageBox(item: PublicMediaItem, viewport: Viewport): { width: number; height: number } {
  const gutter = viewport.width >= WIDE_VIEWPORT_PX ? SIDE_GUTTER_PX * 2 : 0;
  const stageWidth = Math.max(1, viewport.width - gutter);
  const stageHeight = Math.max(1, viewport.height - HEADER_PX - FOOTER_PX);
  const aspect = itemAspectRatio(item, JUSTIFIED_LAYOUT.defaultAspectRatio);
  const width = Math.min(stageWidth, stageHeight * aspect);
  return { width, height: width / aspect };
}

function trapFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

interface IconButtonProps {
  label: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}

function IconButton({ label, onClick, disabled, className = '', children, ref }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex size-12 items-center justify-center rounded-full bg-[var(--color-canvas)]/90 text-[var(--color-ink)] shadow-sm ring-1 ring-[var(--color-line)] transition-opacity duration-[var(--duration-fast)] disabled:pointer-events-none disabled:opacity-0 ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}
