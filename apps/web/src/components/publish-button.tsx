'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authUrlForPublish, claimGuestDraftRequest } from '@/lib/claim-client';

/**
 * Publish entry point for the draft editor (J1, T07). Mounted by the draft screens (`/new`,
 * T06; editor, T15):
 * - signed-out guest → `/auth?intent=publish&galleryId=…&returnTo=…`; after sign-in the auth
 *   page claims the draft with this browser's guest cookie and returns here;
 * - signed-in user still holding the guest draft → claim, then publish;
 * - owner → publish.
 */
export function PublishButton({
  galleryId,
  signedIn,
  isGuestDraft,
  returnTo,
  onPublished,
}: {
  galleryId: string;
  signedIn: boolean;
  /** True while the draft is still owned by the guest session (not yet claimed). */
  isGuestDraft: boolean;
  /** Same-origin path to come back to after sign-in (usually the current page). */
  returnTo: string;
  onPublished?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setError(null);
    if (!signedIn) {
      router.push(authUrlForPublish(galleryId, returnTo));
      return;
    }
    setBusy(true);
    try {
      if (isGuestDraft) {
        const claim = await claimGuestDraftRequest(galleryId);
        if (!claim.ok) {
          setError(
            claim.code === 'not_found'
              ? 'Return to the browser where you started to finish publishing.'
              : claim.message,
          );
          return;
        }
      }
      // TODO(T16): POST /api/v1/galleries/{id}/publish and show the share link immediately.
      onPublished?.();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={publish}
        disabled={busy}
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Publishing…' : 'Publish'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
