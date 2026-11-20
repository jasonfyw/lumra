'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { ApiResponse, CreateGalleryResponse } from '@lumra/contracts';
import { Icon, buttonClass } from '@/components/ui';
import { FeedbackButton, useTransientFlag } from '@/components/ui/feedback-button';

const primary = buttonClass('primary', 'md', 'min-h-11');

/** Creates a gallery (POST /api/v1/galleries) and opens the editor. */
export function NewGalleryButton() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  // Stays true from the click until the editor route has rendered, so the button keeps showing
  // progress while the server renders the next page (no dead time after the POST returns).
  const [navigating, startNavigation] = useTransition();
  const busy = creating || navigating;
  const [error, setError] = useState<string | null>(null);
  // One key per user intent: retries after a network error replay instead of duplicating.
  const keyRef = useRef<string | null>(null);

  async function create() {
    if (busy) return;
    setCreating(true);
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
      startNavigation(() => router.push(`/dashboard/galleries/${body.data.id}`));
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={create}
        // aria-disabled (not `disabled`) keeps focus on the button while it works.
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className={`${primary} aria-disabled:cursor-progress aria-disabled:opacity-80`}
      >
        {busy ? <span className="lm-spinner" aria-hidden="true" /> : <Icon name="plus" size={18} />}
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

/** Copies a share URL; falls back to showing the URL when the Clipboard API is unavailable. */
export function CopyLinkButton({ url, label }: { url: string; label: string }) {
  const [copied, flashCopied] = useTransientFlag();
  const [failed, flashFailed] = useTransientFlag();

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
    } catch {
      flashFailed();
    }
  }

  return (
    <span className="inline-flex items-center justify-end gap-2">
      {failed && (
        <span role="status" className="text-[13px] text-[var(--color-ink-muted)]">
          {url}
        </span>
      )}
      <FeedbackButton
        onClick={copy}
        aria-label={copied ? `Link to ${label} copied` : `Copy link to ${label}`}
        className={buttonClass('ghost', 'sm', 'min-h-11')}
        icon="link"
        label="Copy link"
        doneLabel="Copied"
        announcement={`Link to ${label} copied.`}
        done={copied}
      />
    </span>
  );
}
