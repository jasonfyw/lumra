'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import type { AddResult, Rejection } from '@/lib/upload';

/** File picker `accept`: extensions plus MIME types so iOS/Android pickers offer photos (FR-M01). */
export const PHOTO_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif';

/**
 * Drop zone + native multi-file picker (PRD §4: drag/drop desktop, native picker mobile).
 * The visible control is a real `<button>`, so it is keyboard operable (Enter/Space) and
 * reachable in tab order; the `<input type=file>` itself is visually hidden.
 */
export function UploadZone({
  onFiles,
  disabled = false,
  label = 'Add photos',
}: {
  onFiles: (files: File[]) => Promise<AddResult | void> | AddResult | void;
  disabled?: boolean;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const depth = useRef(0);

  async function handle(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    const result = await onFiles(files);
    setRejected(result ? result.rejected : []);
  }

  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  return (
    <section
      aria-label={label}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        void handle(e.dataTransfer.files);
      }}
      data-dragging={dragging || undefined}
      className="flex flex-col items-center gap-3 rounded-[var(--radius-control)] border-2 border-dashed border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-10 text-center transition-colors duration-[var(--duration-fast)] data-[dragging]:border-[var(--color-accent)] data-[dragging]:bg-white motion-reduce:transition-none"
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={PHOTO_ACCEPT}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        data-testid="upload-input"
        onChange={(e) => {
          void handle(e.currentTarget.files);
          e.currentTarget.value = ''; // allow picking the same file again
        }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => inputRef.current?.click()}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 font-medium text-white disabled:opacity-60"
      >
        Choose photos
      </button>
      <p id={hintId} className="text-sm text-[var(--color-ink-muted)]">
        <span className="pointer-coarse:hidden">or drag them here. </span>
        JPEG, PNG, WebP or HEIC, up to 50 MB each.
      </p>
      {rejected.length > 0 && (
        <div
          role="alert"
          className="w-full max-w-prose text-left text-sm text-[var(--color-danger)]"
        >
          <p className="font-medium">
            {rejected.length === 1
              ? '1 file wasn’t added:'
              : `${rejected.length} files weren’t added:`}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {rejected.slice(0, 10).map((r, i) => (
              <li key={`${r.name}-${i}`}>{r.message}</li>
            ))}
          </ul>
          {rejected.length > 10 && <p>…and {rejected.length - 10} more.</p>}
        </div>
      )}
    </section>
  );
}
