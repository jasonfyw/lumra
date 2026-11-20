'use client';

import { createArchiveResponseSchema } from '@lumra/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon, buttonClass } from '@/components/ui';

export interface DownloadAllButtonProps {
  slug: string;
  /** Ready (downloadable) photos; the button is hidden when there are none. */
  readyCount: number;
}

/**
 * "Download all" (FR-D02/D05, T25): creates — or reuses — a background ZIP archive for the
 * gallery and opens its progress page, where each part is one link (never hundreds of parallel
 * downloads on mobile). Errors are shown inline next to the button.
 */
export function DownloadAllButton({ slug, readyCount }: DownloadAllButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (readyCount === 0) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/public/galleries/${encodeURIComponent(slug)}/archives`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as {
        data?: unknown;
        error?: { message?: string } | null;
      } | null;
      const parsed = createArchiveResponseSchema.safeParse(body?.data);
      if (res.ok && parsed.success) {
        router.push(`/archive/${parsed.data.jobId}`);
        return;
      }
      if (res.status === 401 || res.status === 404 || res.status === 410) router.refresh();
      setError(body?.error?.message ?? 'That didn’t work. Please try again in a moment.');
      setBusy(false);
    } catch {
      setError('You appear to be offline. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        type="button"
        className={buttonClass('primary')}
        onClick={() => void start()}
        disabled={busy}
        aria-busy={busy}
      >
        <Icon name="download" size={18} />
        <span>{busy ? 'Preparing…' : 'Download all'}</span>
      </button>
      {error ? (
        <p className="lm-field-error max-w-xs sm:text-right" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
