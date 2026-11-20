'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui';
import { claimGuestDraftRequest } from '@/lib/claim-client';

/**
 * Post-sign-in step of the publish flow (T07): moves this browser's guest draft into the new
 * account, then returns to the draft. Runs once automatically; failures offer a retry.
 */
export function ClaimDraft({ galleryId, returnTo }: { galleryId: string; returnTo: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<
    { kind: 'working' } | { kind: 'error'; message: string; retryable: boolean }
  >({ kind: 'working' });

  const run = useCallback(async () => {
    setState({ kind: 'working' });
    const result = await claimGuestDraftRequest(galleryId);
    if (result.ok) {
      // TODO(T16): continue straight into publish once the endpoint exists.
      router.replace(returnTo);
      return;
    }
    setState({
      kind: 'error',
      message:
        result.code === 'not_found'
          ? 'This draft is no longer available here. Return to the browser where you started to finish publishing.'
          : result.message,
      retryable: result.retryable,
    });
  }, [galleryId, returnTo, router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  if (state.kind === 'working') {
    return (
      <p role="status" aria-live="polite" className="text-[var(--color-ink-muted)]">
        Saving your draft to your account…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p role="alert" className="lm-banner lm-banner-error">
        {state.message}
      </p>
      <div className="flex flex-wrap gap-2">
        {state.retryable && (
          <button type="button" onClick={() => void run()} className={buttonClass('primary')}>
            Try again
          </button>
        )}
        <Link href="/dashboard" className={buttonClass('ghost')}>
          Go to your galleries
        </Link>
      </div>
    </div>
  );
}
