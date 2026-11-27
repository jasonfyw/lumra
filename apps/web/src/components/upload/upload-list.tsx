'use client';

import { useEffect, useId, useState } from 'react';
import { Icon, buttonClass } from '@/components/ui';
import { formatBytes } from '@/lib/format';
import type { UploadItemSnapshot, UploadSnapshot } from '@/lib/upload';
import { PREVIEWABLE_TYPES } from './upload-bridge';
import { useThrottledAnnouncement } from './use-throttled-announcement';

export function statusText(item: UploadItemSnapshot): string {
  switch (item.state) {
    case 'awaiting_file':
      return 'Paused — choose this file again to resume';
    case 'queued':
      return 'Waiting to upload';
    case 'uploading':
      return `Uploading ${item.percent}% · ${formatBytes(item.bytesUploaded)} of ${formatBytes(item.size)}`;
    case 'uploaded':
      return 'Uploaded';
    case 'processing':
      return 'Uploaded · preparing preview';
    case 'ready':
      return 'Ready';
    case 'failed':
      return item.error?.message ?? 'Upload failed';
    case 'cancelled':
      return 'Cancelled';
    case 'removed':
      return 'Removed';
  }
}

/** One sentence summarising the queue, for the (throttled) live region. */
export function summarize(snapshot: UploadSnapshot): string {
  const { totals, items } = snapshot;
  const counted = items.filter((i) => i.state !== 'cancelled').length;
  if (counted === 0) return '';
  const parts: string[] = [];
  if (totals.uploading + totals.queued > 0) {
    parts.push(`Uploading: ${totals.done} of ${counted} photos done, ${totals.percent}% overall.`);
  } else if (totals.done === counted) {
    parts.push(`All ${counted} ${counted === 1 ? 'photo' : 'photos'} uploaded.`);
  } else {
    parts.push(`${totals.done} of ${counted} photos uploaded.`);
  }
  if (totals.failed > 0)
    parts.push(`${totals.failed} ${totals.failed === 1 ? 'needs' : 'need'} attention.`);
  if (totals.awaitingFile > 0)
    parts.push(`${totals.awaitingFile} waiting for you to choose the files again.`);
  return parts.join(' ');
}

function ProgressBar({ value, label, large }: { value: number; label: string; large?: boolean }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={large ? 'lm-progress lm-progress-lg' : 'lm-progress'}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function Thumb({ file, type }: { file: File | null; type: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !PREVIEWABLE_TYPES.has(type) || typeof URL.createObjectURL !== 'function') return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, type]);
  return (
    <div className="size-10 shrink-0 overflow-hidden bg-[var(--color-sunken)]" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimised */}
      {url && <img src={url} alt="" className="size-full object-cover" />}
    </div>
  );
}

const action = buttonClass('ghost', 'sm', 'min-h-11 min-w-11');
const retryAction = buttonClass('secondary', 'sm', 'min-h-11');

/** How long a fully finished, error-free toast stays before it dismisses itself. */
export const TOAST_AUTO_DISMISS_MS = 5000;

type Phase = 'uploading' | 'attention' | 'paused' | 'done';

interface Counts {
  total: number;
  /** Uploaded to storage (uploaded, processing or ready). */
  uploaded: number;
  active: number;
  failed: number;
  awaiting: number;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countsOf(items: readonly UploadItemSnapshot[]): Counts {
  const counted = items.filter((i) => i.state !== 'cancelled');
  const totalBytes = counted.reduce((n, i) => n + i.size, 0);
  const uploadedBytes = counted.reduce((n, i) => n + i.bytesUploaded, 0);
  return {
    total: counted.length,
    uploaded: counted.filter((i) => ['uploaded', 'processing', 'ready'].includes(i.state)).length,
    active: counted.filter((i) => i.state === 'queued' || i.state === 'uploading').length,
    failed: counted.filter((i) => i.state === 'failed').length,
    awaiting: counted.filter((i) => i.state === 'awaiting_file').length,
    uploadedBytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)) : 0,
  };
}

function phaseOf(c: Counts): Phase {
  if (c.active > 0) return 'uploading';
  if (c.failed > 0) return 'attention';
  if (c.awaiting > 0) return 'paused';
  return 'done';
}

/** Headline of the collapsed summary row. */
export function toastHeadline(phase: Phase, c: Counts): string {
  switch (phase) {
    case 'uploading':
      return `Uploading ${c.uploaded} of ${c.total}…`;
    case 'attention':
      return `${plural(c.failed, 'upload')} ${c.failed === 1 ? 'needs' : 'need'} attention`;
    case 'paused':
      return `${plural(c.awaiting, 'upload')} paused`;
    case 'done':
      return `All ${plural(c.total, 'photo')} uploaded`;
  }
}

/**
 * Floating upload status (PRD §4 Upload UI state): bottom-right on desktop, full-width above the
 * safe area on phones. A collapsed summary row ("Uploading 3 of 12…" + total progress) expands to
 * the per-file list with retry/cancel/remove. When every photo is uploaded (processing continues
 * quietly on the tiles; it is not a second step here) it turns into a done state with a close button and dismisses itself after a few seconds, unless
 * something failed. Progress is announced through a polite, throttled live region.
 */
export function UploadToast({
  snapshot,
  onRetry,
  onCancel,
  onRemove,
  getFile,
  announceIntervalMs = 3000,
  autoDismissMs = TOAST_AUTO_DISMISS_MS,
}: {
  snapshot: UploadSnapshot;
  onRetry: (clientId: string) => void;
  onCancel: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  getFile?: (clientId: string) => File | null;
  announceIntervalMs?: number;
  /** 0 keeps a finished toast until it is closed. */
  autoDismissMs?: number;
}) {
  const announcement = useThrottledAnnouncement(summarize(snapshot), announceIntervalMs);
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [seenFailure, setSeenFailure] = useState(false);
  const [held, setHeld] = useState(false);
  // Items of batches the user already closed: they stay in the engine but not in the toast.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  // A processing failure after the toast was closed reopens it, with Remove.
  const items = snapshot.items.filter(
    (i) => !dismissed.has(i.clientId) || i.error?.code === 'processing_failed',
  );
  const counts = countsOf(items);
  const phase = phaseOf(counts);
  const finished = items.length > 0 && (phase === 'done' || phase === 'attention');

  // Failures open the list once so the reason and Retry are visible without a click.
  if (counts.failed > 0 && !seenFailure) {
    setSeenFailure(true);
    setExpanded(true);
  } else if (counts.failed === 0 && seenFailure) {
    setSeenFailure(false);
  }

  const itemKey = items.map((i) => i.clientId).join(',');
  // Not while the pointer or keyboard focus is inside, so it never vanishes under the user.
  const autoDismiss = phase === 'done' && itemKey !== '' && autoDismissMs > 0 && !held;
  useEffect(() => {
    if (!autoDismiss) return;
    const ids = itemKey.split(',');
    const timer = setTimeout(() => setDismissed((d) => new Set([...d, ...ids])), autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismiss, autoDismissMs, itemKey]);

  function close() {
    setDismissed((d) => new Set([...d, ...items.map((i) => i.clientId)]));
  }

  return (
    <>
      <p aria-live="polite" role="status" className="sr-only" data-testid="upload-announcer">
        {announcement}
      </p>
      {items.length > 0 && (
        <section
          aria-label="Uploads"
          className="lm-toast"
          data-phase={phase}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="-ml-2 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setExpanded((v) => !v)}
              >
                {phase === 'done' && (
                  <Icon name="check" size={18} className="shrink-0 text-[var(--color-success)]" />
                )}
                {phase === 'attention' && (
                  <Icon name="alert" size={18} className="shrink-0 text-[var(--color-danger)]" />
                )}
                <span
                  className={`lm-title-2 min-w-0 flex-1 truncate ${phase === 'attention' ? 'text-[var(--color-danger)]' : ''}`}
                >
                  {toastHeadline(phase, counts)}
                </span>
                <Icon
                  name="chevron-down"
                  size={18}
                  className={`shrink-0 text-[var(--color-ink-muted)] transition-transform motion-reduce:transition-none ${expanded ? '' : 'rotate-180'}`}
                />
              </button>
              {finished && (
                <button
                  type="button"
                  className={action}
                  aria-label="Close upload status"
                  onClick={close}
                >
                  <Icon name="x" size={18} />
                </button>
              )}
            </div>
            {phase !== 'done' && (
              <ProgressBar value={counts.percent} label="Total upload progress" large />
            )}
          </div>
          {expanded && (
            <div id={bodyId} className="lm-toast-body">
              <p className="lm-num py-2 text-[13px] text-[var(--color-ink-muted)]">
                {formatBytes(counts.uploadedBytes)} of {formatBytes(counts.totalBytes)}
              </p>
              <ul className="flex flex-col divide-y divide-[var(--color-hairline)]">
                {items.map((item) => (
                  <UploadRow
                    key={item.clientId}
                    item={item}
                    file={getFile?.(item.clientId) ?? null}
                    onRetry={onRetry}
                    onCancel={onCancel}
                    onRemove={onRemove}
                  />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function UploadRow({
  item,
  file,
  onRetry,
  onCancel,
  onRemove,
}: {
  item: UploadItemSnapshot;
  file: File | null;
  onRetry: (clientId: string) => void;
  onCancel: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}) {
  const failed = item.state === 'failed';
  const canRetry = failed && item.error?.retryable !== false && !item.error?.requiresAuth;
  const canCancel = item.state === 'queued' || item.state === 'uploading';
  const canRemove = failed || item.state === 'cancelled' || item.state === 'awaiting_file';
  return (
    <li
      className="flex items-center gap-3 py-2 data-[state=failed]:-mx-2 data-[state=failed]:rounded-[var(--radius-sm)] data-[state=failed]:bg-[var(--color-danger-soft)] data-[state=failed]:px-2"
      data-state={item.state}
    >
      <Thumb file={file} type={item.type} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] leading-[18px] font-medium" title={item.name}>
          {item.name}
        </span>
        <span
          className={`lm-num text-[12px] leading-4 ${failed ? 'font-medium text-[var(--color-danger)]' : item.state === 'ready' ? 'text-[var(--color-success)]' : 'text-[var(--color-ink-muted)]'}`}
        >
          {statusText(item)}
        </span>
        {(item.state === 'uploading' || item.state === 'queued') && (
          <div className="mt-1">
            <ProgressBar value={item.percent} label={`${item.name} upload progress`} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {canRetry && (
          <button
            type="button"
            className={retryAction}
            onClick={() => onRetry(item.clientId)}
            aria-label={`Retry ${item.name}`}
          >
            Retry
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className={action}
            onClick={() => onCancel(item.clientId)}
            aria-label={`Cancel ${item.name}`}
          >
            Cancel
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            className={action}
            onClick={() => onRemove(item.clientId)}
            aria-label={`Remove ${item.name}`}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
