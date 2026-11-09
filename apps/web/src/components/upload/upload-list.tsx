'use client';

import { useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui';
import { formatBytes } from '@/lib/format';
import type { UploadItemSnapshot, UploadSnapshot } from '@/lib/upload';
import { useThrottledAnnouncement } from './use-throttled-announcement';

const PREVIEWABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function statusText(item: UploadItemSnapshot): string {
  switch (item.state) {
    case 'awaiting_file':
      return 'Paused — choose this file again to resume';
    case 'queued':
      return 'Waiting to upload';
    case 'uploading':
      return `Uploading ${item.percent}% · ${formatBytes(item.bytesUploaded)} of ${formatBytes(item.size)}`;
    case 'uploaded':
      return 'Uploaded · processing soon';
    case 'processing':
      return 'Processing';
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
    if (!file || !PREVIEWABLE.has(type) || typeof URL.createObjectURL !== 'function') return;
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

/**
 * Per-file tiles with status text and actions, plus total progress and a polite, throttled
 * live region (PRD §4 Upload UI state).
 */
export function UploadList({
  snapshot,
  onRetry,
  onCancel,
  onRemove,
  getFile,
  announceIntervalMs = 3000,
}: {
  snapshot: UploadSnapshot;
  onRetry: (clientId: string) => void;
  onCancel: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  getFile?: (clientId: string) => File | null;
  announceIntervalMs?: number;
}) {
  const announcement = useThrottledAnnouncement(summarize(snapshot), announceIntervalMs);
  const visible = snapshot.items;

  return (
    <section aria-label="Uploads" className="flex flex-col gap-3">
      <p aria-live="polite" role="status" className="sr-only" data-testid="upload-announcer">
        {announcement}
      </p>
      {visible.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="lm-title-2">
              {snapshot.totals.done} of {visible.filter((i) => i.state !== 'cancelled').length}{' '}
              uploaded
            </span>
            <span className="lm-num text-[13px] text-[var(--color-ink-muted)]">
              {formatBytes(snapshot.totals.uploadedBytes)} of{' '}
              {formatBytes(snapshot.totals.totalBytes)}
            </span>
          </div>
          <ProgressBar value={snapshot.totals.percent} label="Total upload progress" large />
        </div>
      )}
      <ul className="flex flex-col divide-y divide-[var(--color-hairline)]">
        {visible.map((item) => {
          const failed = item.state === 'failed';
          const canRetry = failed && item.error?.retryable !== false && !item.error?.requiresAuth;
          const canCancel = item.state === 'queued' || item.state === 'uploading';
          const canRemove = failed || item.state === 'cancelled' || item.state === 'awaiting_file';
          return (
            <li
              key={item.clientId}
              className="flex items-center gap-3 py-2 data-[state=failed]:-mx-2 data-[state=failed]:rounded-[var(--radius-sm)] data-[state=failed]:bg-[var(--color-danger-soft)] data-[state=failed]:px-2"
              data-state={item.state}
            >
              <Thumb file={getFile?.(item.clientId) ?? null} type={item.type} />
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
        })}
      </ul>
    </section>
  );
}
