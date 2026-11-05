'use client';

import { useRef, useState } from 'react';
import type { EditorMediaItem, MediaStatus } from '@lumra/contracts';

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

const small =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 text-sm disabled:opacity-40';

interface DragState {
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Editor grid (T15): status tiles, cover selection, delete, and reorder by drag (mouse/pen:
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
}: {
  items: readonly EditorMediaItem[];
  coverMediaId: string | null;
  effectiveCoverMediaId: string | null;
  disabled?: boolean;
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
      <p className="rounded-[var(--radius-control)] border border-dashed border-[var(--color-line)] p-8 text-center text-[var(--color-ink-muted)]">
        No photos yet.
      </p>
    );
  }

  return (
    <ol
      aria-label="Photos in this gallery"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
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
              'flex flex-col overflow-hidden rounded-[var(--radius-control)] border bg-[var(--color-surface)]',
              dragOver === index && dragFrom !== null && dragFrom !== index
                ? 'border-[var(--color-focus)] ring-2 ring-[var(--color-focus)]'
                : 'border-[var(--color-line)]',
              dragFrom === index ? 'opacity-50' : '',
            ].join(' ')}
          >
            <div className="relative flex aspect-[4/3] items-center justify-center bg-[var(--color-line)]">
              {item.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived gateway URL
                <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span
                  className={`px-2 text-center text-sm ${item.status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-muted)]'}`}
                >
                  {STATUS_LABEL[item.status]}
                </span>
              )}
              {isHero && (
                <span className="absolute left-2 top-2 rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white">
                  {isCover ? 'Cover' : 'Cover (auto)'}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2 p-2">
              <p className="truncate text-sm" title={item.filename}>
                {item.filename}
              </p>
              <div className="flex flex-wrap gap-1">
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
                  <span aria-hidden="true">⠿</span>
                </button>
                <button
                  type="button"
                  className={small}
                  aria-label={`Move ${item.filename} earlier`}
                  disabled={disabled || index === 0}
                  onClick={() => onMove(index, index - 1)}
                >
                  <span aria-hidden="true">←</span>
                </button>
                <button
                  type="button"
                  className={small}
                  aria-label={`Move ${item.filename} later`}
                  disabled={disabled || index === items.length - 1}
                  onClick={() => onMove(index, index + 1)}
                >
                  <span aria-hidden="true">→</span>
                </button>
                <button
                  type="button"
                  className={small}
                  aria-pressed={isCover}
                  aria-label={
                    isCover ? `Unset ${item.filename} as cover` : `Use ${item.filename} as cover`
                  }
                  disabled={disabled}
                  onClick={() => onSetCover(isCover ? null : item.id)}
                >
                  {isCover ? 'Cover ✓' : 'Cover'}
                </button>
                <button
                  type="button"
                  className={`${small} text-[var(--color-danger)]`}
                  aria-label={`Delete ${item.filename}`}
                  disabled={disabled}
                  onClick={() => onDelete(item)}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
