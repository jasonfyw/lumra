'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { ApiResponse, CreateGalleryResponse } from '@lumra/contracts';

const primary =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-5 font-medium text-white disabled:opacity-60';

/** Creates a gallery (POST /api/v1/galleries) and opens the editor. */
export function NewGalleryButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per user intent: retries after a network error replay instead of duplicating.
  const keyRef = useRef<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    keyRef.current ??= crypto.randomUUID();
    try {
      const res = await fetch('/api/v1/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyRef.current },
        body: '{}',
      });
      const body = (await res.json()) as ApiResponse<CreateGalleryResponse>;
      if (body.error) {
        setError(body.error.message);
        if (!body.error.retryable) keyRef.current = null;
        return;
      }
      keyRef.current = null;
      router.push(`/dashboard/galleries/${body.data.id}`);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={create} disabled={busy} className={primary}>
        {busy ? 'Creating…' : 'New gallery'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}{' '}
          <Link href="/pricing" className="underline underline-offset-4">
            See plans
          </Link>
        </p>
      )}
    </div>
  );
}

/** Copies a share URL; falls back to selecting the text when the Clipboard API is unavailable. */
export function CopyLinkButton({ url, label }: { url: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    setTimeout(() => setStatus('idle'), 2000);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy link to ${label}`}
        className="min-h-11 underline-offset-4 hover:underline"
      >
        Copy link
      </button>
      <span aria-live="polite" className="text-sm text-[var(--color-ink-muted)]">
        {status === 'copied' ? 'Copied' : status === 'failed' ? url : ''}
      </span>
    </span>
  );
}
