'use client';

import { useEffect, useState } from 'react';
import type { UploadItemSnapshot } from '@/lib/upload';
import { PREVIEWABLE_TYPES } from './upload-bridge';
import { statusText } from './upload-list';

function Preview({
  file,
  type,
  name,
  dimmed,
}: {
  file: File | null;
  type: string;
  name: string;
  dimmed: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !PREVIEWABLE_TYPES.has(type) || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, type]);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimised
    <img
      src={url}
      alt={name}
      className={`size-full object-cover ${dimmed ? 'lm-tile-pending-img' : ''}`}
    />
  ) : null;
}

/**
 * The guest draft's photos (PRD J1 "uploading tiles appear"). A guest has no editor (editing
 * needs an account), so this persistent grid is where an uploaded photo shows up: a local
 * preview while this page still holds the file, otherwise a labelled tile (HEIC, or after a
 * reload: guests have no signed thumbnail URLs). Unlike the upload toast it never dismisses.
 * Once the bytes are uploaded the preview shows at full strength; processing is only a small
 * corner dot (processing is not a second step for the guest).
 */
export function UploadGrid({
  items,
  getFile,
}: {
  items: readonly UploadItemSnapshot[];
  getFile?: (clientId: string) => File | null;
}) {
  const visible = items.filter((i) => i.state !== 'cancelled' && i.state !== 'removed');
  if (visible.length === 0) return null;
  return (
    <ul
      aria-label="Photos in this gallery"
      data-testid="guest-grid"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
    >
      {visible.map((item) => {
        const finishing = item.state === 'uploaded' || item.state === 'processing';
        const pending = item.state === 'queued' || item.state === 'uploading';
        return (
          <li
            key={item.clientId}
            data-state={item.state}
            className="relative aspect-square overflow-hidden bg-[var(--color-sunken)]"
          >
            <Preview
              file={getFile?.(item.clientId) ?? null}
              type={item.type}
              name={item.name}
              dimmed={pending}
            />
            {finishing && (
              <span className="lm-tile-finishing top-2 bottom-auto" data-testid="tile-finishing">
                <span className="sr-only">Processing</span>
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-[var(--color-surface)]/85 px-2 py-1">
              <span className="truncate text-[12px] leading-4 font-medium" title={item.name}>
                {item.name}
              </span>
              <span className="lm-num truncate text-[11px] leading-4 text-[var(--color-ink-muted)]">
                {finishing ? 'Uploaded' : statusText(item)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
