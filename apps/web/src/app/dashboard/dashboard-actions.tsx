'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { ApiResponse, CreateGalleryResponse } from '@lumra/contracts';
import { Icon, buttonClass } from '@/components/ui';

const primary = buttonClass('primary', 'md', 'min-h-11');

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
    <div className="flex flex-col items-end gap-2">
      <button type="button" onClick={create} disabled={busy} className={primary}>
        <Icon name="plus" size={18} />
        {busy ? 'Creating…' : 'New gallery'}
      </button>
      {error && (
        <p role="alert" className="lm-field-error max-w-xs text-right">
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
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-live="polite" className="text-[13px] text-[var(--color-ink-muted)]">
        {status === 'copied' ? 'Copied' : status === 'failed' ? url : ''}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy link to ${label}`}
        className={buttonClass('ghost', 'sm', 'min-h-11')}
      >
        <Icon name={status === 'copied' ? 'check' : 'link'} size={16} />
        Copy link
      </button>
    </span>
  );
}
