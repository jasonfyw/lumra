'use client';

import { useRef, useState } from 'react';
import type { EditorMediaItem, MediaStatus } from '@lumra/contracts';
import type { SelectClick } from '@lumra/domain';
import { Icon } from '@/components/ui';
import { tilePhase, type LocalUpload, type TilePhase } from './thumbnails';

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

/** Accessible label of a tile, by the phase it presents (not the raw server status). */
export function phaseLabel(item: EditorMediaItem, phase: TilePhase): string {
  switch (phase) {
    case 'uploading':
      return STATUS_LABEL[item.status === 'reserved' ? 'reserved' : 'uploading'];
    case 'finishing':
      return 'Uploaded, preparing preview';
    case 'ready':
      return STATUS_LABEL.ready;
    case 'failed':
      return STATUS_LABEL.failed;
    case 'upload_failed':
      return 'Upload interrupted';
    case 'removing':
      return STATUS_LABEL.deleting;
  }
}

/**
 * The picture area of one tile, by the phase it presents (`tilePhase`):
 * - uploading → dimmed local preview (or shimmer) with a thin progress bar; without local
 *   knowledge of the upload (another tab, after a reload) the centered status chip;
 * - finishing (bytes are in; processing runs quietly) → the local preview at full strength with
 *   a small corner dot; no chip, no dimming;
 * - ready → the owner thumbnail; when a local preview is still held it stays underneath and the
 *   gateway image crossfades in once it has loaded, so the swap never flashes blank;
 * - upload_failed → dimmed local preview + alert badge; failed → icon + short text.
 */
export function TileMedia({
  item,
  localPreview,
  local,
  onThumbnailError,
  onPreviewSwapped,
}: {
  item: EditorMediaItem;
  localPreview?: string;
  local?: LocalUpload;
  onThumbnailError?: (mediaId: string) => void;
  /** The gateway thumbnail is on screen, so the local blob can be released. */
  onPreviewSwapped?: (mediaId: string) => void;
}) {
  // The `src` that failed to load / has loaded; a newer URL from the next refresh renders again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const phase = tilePhase(item, local);

  if (phase === 'failed') {
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

  const remote = phase === 'ready' && item.thumbnailUrl ? item.thumbnailUrl : null;
  const remoteUsable = remote !== null && remote !== failedSrc;
  const dimmed = phase === 'uploading' || phase === 'upload_failed' || phase === 'removing';
  const placeholder = phase === 'ready' || phase === 'upload_failed';
  const showChip = phase === 'removing' || (phase === 'uploading' && !local);
  const progress = phase === 'uploading' && local ? local.percent : null;
  // The gateway image is visible once loaded, or straight away when nothing sits underneath.
  const remoteVisible = !localPreview || loadedSrc === remote;

  return (
    <div className="relative h-full w-full">
      {localPreview && (
        // eslint-disable-next-line @next/next/no-img-element -- local blob preview
        <img
          src={localPreview}
          alt=""
          decoding="async"
          draggable={false}
          className={`h-full w-full object-cover ${dimmed ? 'lm-tile-pending-img' : ''}`}
          data-testid="tile-thumbnail"
        />
      )}
      {remoteUsable && (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived gateway URL
        <img
          key={remote}
          src={remote}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`${localPreview ? 'absolute inset-0 ' : ''}h-full w-full object-cover transition-opacity duration-[var(--duration-fast)] motion-reduce:transition-none ${remoteVisible ? 'opacity-100' : 'opacity-0'}`}
          data-testid={localPreview ? 'tile-thumbnail-remote' : 'tile-thumbnail'}
          onLoad={() => {
            setLoadedSrc(remote);
            if (localPreview) onPreviewSwapped?.(item.id);
          }}
          onError={() => {
            setFailedSrc(remote);
            onThumbnailError?.(item.id);
          }}
        />
      )}
      {!localPreview &&
        !remoteUsable &&
        (placeholder ? (
          <span
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center bg-[var(--color-sunken)] text-[var(--color-ink-muted)]"
          >
            <Icon name="image" size={24} />
          </span>
        ) : (
          <span aria-hidden="true" className="lm-shimmer block h-full w-full" />
        ))}
      {showChip && (
        <span className="lm-tile-status" data-testid="tile-pending">
          <span className="lm-tile-status-chip">
            <span className="lm-spinner" aria-hidden="true" />
            <Icon name="clock" size={20} className="lm-spinner-static" />
            <span className="sr-only">
              {phase === 'removing'
                ? 'Removing'
                : item.status === 'reserved'
                  ? 'Waiting to upload'
                  : 'Uploading'}
            </span>
          </span>
        </span>
      )}
      {progress !== null && (
        <span
          className="lm-tile-progress"
          role="progressbar"
          aria-label={`Uploading ${item.filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          data-testid="tile-progress"
        >
          <span style={{ width: `${progress}%` }} />
        </span>
      )}
      {phase === 'finishing' && (
        <span className="lm-tile-finishing" data-testid="tile-finishing">
          <span className="sr-only">Processing</span>
        </span>
      )}
      {phase === 'upload_failed' && (
        <span className="lm-tile-alert" data-testid="tile-upload-failed">
          <Icon name="alert" size={16} />
          <span className="sr-only">Upload interrupted — retry from the upload panel</span>
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
 * Move later" buttons as the non-drag alternative (PRD §4). Tiles can be multi-selected (checkbox,
 * shift-click range, Cmd/Ctrl-click toggle); dragging a selected tile moves the whole selection.
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
  localUploads,
  onThumbnailError,
  onPreviewSwapped,
  selected,
  onSelect,
  onDragMove,
}: {
  items: readonly EditorMediaItem[];
  coverMediaId: string | null;
  effectiveCoverMediaId: string | null;
  disabled?: boolean;
  /** Object URLs of files still held by the uploader on this page, by media id. */
  localPreviews?: ReadonlyMap<string, string>;
  /** What the uploader on this page knows about each photo, by media id. */
  localUploads?: ReadonlyMap<string, LocalUpload>;
  /** A tile's gateway thumbnail is on screen, so its local preview can be released. */
  onPreviewSwapped?: (mediaId: string) => void;
  /** A ready tile's gateway thumbnail failed to load (e.g. its token expired). */
  onThumbnailError?: (mediaId: string) => void;
  /** Selected media ids; omitted = selection UI off. */
  selected?: ReadonlySet<string>;
  onSelect?: (mediaId: string, click: SelectClick) => void;
  /** A completed drag (defaults to `onMove`); the owner moves the whole selection if needed. */
  onDragMove?: (from: number, to: number) => void;
  onMove: (from: number, to: number) => void;
  onSetCover: (mediaId: string | null) => void;
  onDelete: (item: EditorMediaItem) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const selecting = (selected?.size ?? 0) > 0;
  // Dragging a selected tile drags the whole selection.
  const draggedId = dragFrom === null ? null : items[dragFrom]?.id;
  const draggingGroup = draggedId != null && (selected?.has(draggedId) ?? false);

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
    if (wasActive && target !== null && target !== state.from) {
      (onDragMove ?? onMove)(state.from, target);
    }
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
        const isSelected = selected?.has(item.id) ?? false;
        const dimmed = dragFrom === index || (draggingGroup && isSelected);
        return (
          <li
            key={item.id}
            data-tile-index={index}
            aria-label={`${item.filename}, ${phaseLabel(item, tilePhase(item, localUploads?.get(item.id)))}, position ${position}`}
            className={[
              'relative flex flex-col transition-opacity duration-[var(--duration-fast)]',
              dimmed ? 'opacity-35' : '',
            ].join(' ')}
          >
            <div
              className={[
                'group relative aspect-[4/3] bg-[var(--color-sunken)]',
                onSelect ? 'select-none' : '',
                isSelected ? 'outline-[3px] -outline-offset-[3px] outline-[var(--color-ink)]' : '',
              ].join(' ')}
              data-testid="media-tile"
              data-status={item.status}
              data-selected={isSelected ? 'true' : undefined}
              onClick={(e) => {
                if (!onSelect || disabled) return;
                const shift = e.shiftKey;
                const toggle = e.metaKey || e.ctrlKey || (selecting && !shift);
                if (shift || toggle) onSelect(item.id, { shift, toggle });
              }}
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
                local={localUploads?.get(item.id)}
                onThumbnailError={onThumbnailError}
                onPreviewSwapped={onPreviewSwapped}
              />
              {onSelect && (
                <label
                  className={[
                    'absolute top-1 left-1 z-10 flex size-9 cursor-pointer items-center justify-center pointer-coarse:size-11',
                    selecting || isSelected
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
                  ].join(' ')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="size-5 cursor-pointer accent-[var(--color-ink)]"
                    aria-label={`Select ${item.filename}`}
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => undefined}
                    onClick={(e) => onSelect(item.id, { shift: e.shiftKey, toggle: true })}
                  />
                </label>
              )}
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
