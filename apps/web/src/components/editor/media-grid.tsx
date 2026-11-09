'use client';

import { useRef, useState } from 'react';
import type { EditorMediaItem, MediaStatus } from '@lumra/contracts';
import { Icon } from '@/components/ui';

/** Creator-facing tile labels: the creator sees pipeline states, incl. recoverable failures. */
export const STATUS_LABEL: Record<MediaStatus, string> = {
  reserved: 'Waiting to upload',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Unavailable — re-upload or delete',
  deleting: 'Removing',
  deleted: 'Removed',
};

/** Pipeline states shown as a spinner overlay (still uploading or processing). */
const IN_PROGRESS: ReadonlySet<MediaStatus> = new Set([
  'reserved',
  'uploading',
  'uploaded',
  'processing',
  'deleting',
]);

/** Short overlay label (visually hidden; announced with the spinner). */
const PENDING_LABEL: Partial<Record<MediaStatus, string>> = {
  reserved: 'Waiting to upload',
  uploading: 'Uploading',
  uploaded: 'Processing',
  processing: 'Processing',
  deleting: 'Removing',
};

/**
 * The picture area of one tile:
 * - ready → the owner thumbnail only (no badge); without one, a neutral image placeholder;
 * - uploading/processing → spinner overlay over the local preview (if the uploader on this page
 *   still holds the file) or over the neutral shimmer; static icon under reduced motion;
 * - failed → icon + short text, full message as tooltip (never colour alone).
 */
export function TileMedia({
  item,
  localPreview,
  onThumbnailError,
}: {
  item: EditorMediaItem;
  localPreview?: string;
  onThumbnailError?: (mediaId: string) => void;
}) {
  // The `src` that failed to load; a newer URL from the next refresh renders again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (item.status === 'failed') {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[var(--color-danger-soft)] px-2 text-center text-[var(--color-danger)]"
        title={STATUS_LABEL.failed}
        data-testid="tile-failed"
      >
        <Icon name="alert" size={22} />
        <span className="text-[13px] leading-[18px] font-medium">Unavailable</span>
        <span className="text-[12px] leading-4">Re-upload or delete</span>
      </div>
    );
  }

  const pending = IN_PROGRESS.has(item.status);
  const remote = item.status === 'ready' ? item.thumbnailUrl : null;
  const src = remote && remote !== failedSrc ? remote : (localPreview ?? null);

  return (
    <div className="relative h-full w-full">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived gateway URL / local blob
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`h-full w-full object-cover ${pending ? 'lm-tile-pending-img' : ''}`}
          data-testid="tile-thumbnail"
          onError={() => {
            if (src !== remote) return;
            setFailedSrc(src);
            onThumbnailError?.(item.id);
          }}
        />
      ) : pending ? (
        <span aria-hidden="true" className="lm-shimmer block h-full w-full" />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center bg-[var(--color-sunken)] text-[var(--color-ink-muted)]"
        >
          <Icon name="image" size={24} />
        </span>
      )}
      {pending && (
        <span className="lm-tile-status" data-testid="tile-pending">
          <span className="lm-tile-status-chip">
            <span className="lm-spinner" aria-hidden="true" />
            <Icon name="clock" size={20} className="lm-spinner-static" />
            <span className="sr-only">{PENDING_LABEL[item.status] ?? 'Processing'}</span>
          </span>
        </span>
      )}
    </div>
  );
}

/** Returns a copy of `list` with the element at `from` moved to index `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

const LONG_PRESS_MS = 400;
const DRAG_SLOP_PX = 6;

/** Tile controls: 36px icon buttons on fine pointers, the full 44px tap target on touch. */
const small = 'lm-iconbtn size-9 pointer-coarse:size-11';

interface DragState {
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Editor grid (T15): photo thumbnails with status overlays, cover selection, delete, and reorder by drag (mouse/pen:
 * drag the handle; touch: long-press the handle, then drag) with accessible "Move earlier /
 * Move later" buttons as the non-drag alternative (PRD §4).
 */
export function MediaGrid({
  items,
  coverMediaId,
  effectiveCoverMediaId,
  disabled,
  onMove,
  onSetCover,
  onDelete,
  localPreviews,
  onThumbnailError,
}: {
  items: readonly EditorMediaItem[];
  coverMediaId: string | null;
  effectiveCoverMediaId: string | null;
  disabled?: boolean;
  /** Object URLs of files still held by the uploader on this page, by media id. */
  localPreviews?: ReadonlyMap<string, string>;
  /** A ready tile's gateway thumbnail failed to load (e.g. its token expired). */
  onThumbnailError?: (mediaId: string) => void;
  onMove: (from: number, to: number) => void;
  onSetCover: (mediaId: string | null) => void;
  onDelete: (item: EditorMediaItem) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function indexAt(x: number, y: number): number | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tile-index]');
    return el ? Number(el.dataset.tileIndex) : null;
  }

  function begin(state: DragState) {
    state.active = true;
    setDragFrom(state.from);
    setDragOver(state.from);
  }

  function reset() {
    if (drag.current?.timer) clearTimeout(drag.current.timer);
    drag.current = null;
    setDragFrom(null);
    setDragOver(null);
  }

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>, index: number) {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const state: DragState = {
      from: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      timer: null,
    };
    if (event.pointerType === 'touch') {
      state.timer = setTimeout(() => {
        if (drag.current === state) begin(state);
      }, LONG_PRESS_MS);
    }
    drag.current = state;
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    if (!state.active) {
      if (event.pointerType === 'touch') {
        // Moving before the long-press fires is a scroll, not a drag.
        if (moved > DRAG_SLOP_PX) reset();
        return;
      }
      if (moved < DRAG_SLOP_PX) return;
      begin(state);
    }
    event.preventDefault();
    const over = indexAt(event.clientX, event.clientY);
    if (over !== null) setDragOver(over);
  }

  function onPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const target = dragOver;
    const wasActive = state.active;
    reset();
    if (wasActive && target !== null && target !== state.from) onMove(state.from, target);
  }

  if (items.length === 0) {
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-sunken)] p-8 text-center text-[var(--color-ink-muted)]">
        No photos yet.
      </p>
    );
  }

  return (
    <ol
      aria-label="Photos in this gallery"
      className="grid grid-cols-2 gap-x-1 gap-y-3 sm:grid-cols-3 xl:grid-cols-4"
    >
      {items.map((item, index) => {
        const isCover = coverMediaId === item.id;
        const isHero = effectiveCoverMediaId === item.id;
        const position = `${index + 1} of ${items.length}`;
        return (
          <li
            key={item.id}
            data-tile-index={index}
            aria-label={`${item.filename}, ${STATUS_LABEL[item.status]}, position ${position}`}
            className={[
              'relative flex flex-col transition-opacity duration-[var(--duration-fast)]',
              dragFrom === index ? 'opacity-35' : '',
            ].join(' ')}
          >
            <div
              className="relative aspect-[4/3] bg-[var(--color-sunken)]"
              data-testid="media-tile"
              data-status={item.status}
            >
              {dragOver === index && dragFrom !== null && dragFrom !== index && (
                // The ink drop line marks where the dragged photo lands.
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 z-10 w-[3px] bg-[var(--color-ink)] shadow-[0_0_0_1px_var(--color-surface)] ${dragFrom < index ? '-right-0.5' : '-left-0.5'}`}
                />
              )}
              <TileMedia
                item={item}
                localPreview={localPreviews?.get(item.id)}
                onThumbnailError={onThumbnailError}
              />
              {isHero && (
                <span className="lm-tag lm-tag-surface absolute top-2 right-2 shadow-[var(--shadow-raised)]">
                  <Icon name="star" size={14} />
                  {isCover ? 'Cover' : 'Cover (auto)'}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-0.5 pt-1.5">
              <p
                className="truncate text-[12px] leading-4 text-[var(--color-ink-muted)]"
                title={item.filename}
              >
                {item.filename}
              </p>
              <div className="-ml-1.5 flex flex-wrap items-center">
                <button
                  type="button"
                  className={`${small} cursor-grab touch-none select-none`}
                  aria-label={`Drag to reorder ${item.filename}`}
                  title="Drag to reorder (long-press on touch)"
                  disabled={disabled}
                  onPointerDown={(e) => onPointerDown(e, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={reset}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <Icon name="grip" size={18} />
                </button>
                <button
                  type="button"
                  className={small}
                  aria-label={`Move ${item.filename} earlier`}
                  disabled={disabled || index === 0}
                  onClick={() => onMove(index, index - 1)}
                >
                  <Icon name="chevron-left" size={18} />
                </button>
                <button
                  type="button"
                  className={small}
                  aria-label={`Move ${item.filename} later`}
                  disabled={disabled || index === items.length - 1}
                  onClick={() => onMove(index, index + 1)}
                >
                  <Icon name="chevron-right" size={18} />
                </button>
                <button
                  type="button"
                  className={`${small} aria-pressed:bg-[var(--color-lumen-soft)] aria-pressed:text-[var(--color-lumen-ink)]`}
                  aria-pressed={isCover}
                  aria-label={
                    isCover ? `Unset ${item.filename} as cover` : `Use ${item.filename} as cover`
                  }
                  disabled={disabled}
                  onClick={() => onSetCover(isCover ? null : item.id)}
                >
                  <Icon name="star" size={18} />
                </button>
                <button
                  type="button"
                  className={`${small} ml-auto text-[var(--color-danger)]`}
                  aria-label={`Delete ${item.filename}`}
                  disabled={disabled}
                  onClick={() => onDelete(item)}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
