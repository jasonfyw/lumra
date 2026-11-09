'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PublishButton } from '@/components/publish-button';
import { AppHeader, Icon, Tag, buttonClass } from '@/components/ui';
import { GalleryUploader } from '@/components/upload';
import { authUrlForPublish } from '@/lib/claim-client';
import { openDraftStore } from '@/lib/draft-store';
import { createUploadApi, UploadApiError } from '@/lib/upload';

type Setup =
  | { kind: 'pending' }
  | { kind: 'ready'; galleryId: string }
  | { kind: 'error'; message: string; retryable: boolean; upgrade?: boolean };

const IDEMPOTENCY_KEY = 'lumra:new-gallery-key';

function sessionKey(): string {
  try {
    const existing = sessionStorage.getItem(IDEMPOTENCY_KEY);
    if (existing) return existing;
    const key = crypto.randomUUID();
    sessionStorage.setItem(IDEMPOTENCY_KEY, key);
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

export function NewGallery({
  signedIn,
  initialGalleryId,
}: {
  signedIn: boolean;
  initialGalleryId: string | null;
}) {
  const router = useRouter();
  const [api] = useState(() => createUploadApi());
  const [setup, setSetup] = useState<Setup>(
    initialGalleryId ? { kind: 'ready', galleryId: initialGalleryId } : { kind: 'pending' },
  );
  // TODO(T15): persist via PATCH /api/v1/galleries/{id} (no title endpoint yet, guests included).
  const [title, setTitle] = useState('');
  const started = useRef(false);

  const start = useCallback(async () => {
    setSetup({ kind: 'pending' });
    try {
      if (signedIn) {
        // One Idempotency-Key per tab: a refresh mid-request replays instead of duplicating.
        const gallery = await api.createGallery(sessionKey());
        try {
          sessionStorage.removeItem(IDEMPOTENCY_KEY);
        } catch {
          // Storage blocked: the key was never persisted either.
        }
        setSetup({ kind: 'ready', galleryId: gallery.id });
        router.replace(`/new?gallery=${gallery.id}`);
        return;
      }
      // Reuses this browser's live draft (cookie) if there is one, else creates it (FR-A01).
      const draft = await api.createGuestDraft();
      const store = await openDraftStore().catch(() => null);
      await store?.saveDraft(draft).catch(() => {});
      store?.close();
      setSetup({ kind: 'ready', galleryId: draft.galleryId });
    } catch (error) {
      if (error instanceof UploadApiError) {
        setSetup({
          kind: 'error',
          message:
            error.code === 'rate_limited'
              ? 'Too many new drafts from this network. Please wait a moment and try again.'
              : error.message,
          retryable: error.retryable || error.transient,
          upgrade: error.code === 'quota_exceeded',
        });
      } else {
        setSetup({ kind: 'error', message: 'Something went wrong. Try again.', retryable: true });
      }
    }
  }, [api, router, signedIn]);

  useEffect(() => {
    if (started.current || initialGalleryId) return;
    started.current = true;
    void start();
  }, [initialGalleryId, start]);

  const galleryId = setup.kind === 'ready' ? setup.galleryId : null;
  const returnTo = galleryId ? `/new?gallery=${galleryId}` : '/new';
  const mode = signedIn ? 'owner' : 'guest';

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        actions={
          signedIn ? (
            <Link href="/dashboard" className={buttonClass('ghost')}>
              Your galleries
            </Link>
          ) : null
        }
      >
        <Tag dot>Draft</Tag>
      </AppHeader>

      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-6 px-4 pt-6 pb-8 sm:px-8 sm:pt-10">
        <header className="flex flex-col gap-1">
          <h1 className="lm-title-1">New gallery</h1>
          {!signedIn && (
            <p className="text-[var(--color-ink-muted)]">No account needed to start.</p>
          )}
        </header>

        <div className="lm-field">
          <label htmlFor="gallery-title" className="lm-field-label">
            Title <span className="font-normal text-[var(--color-ink-muted)]">(optional)</span>
          </label>
          <input
            id="gallery-title"
            type="text"
            value={title}
            maxLength={200}
            placeholder="Untitled gallery"
            onChange={(e) => setTitle(e.target.value)}
            className="lm-input"
          />
        </div>

        {setup.kind === 'error' && (
          <div role="alert" className="lm-banner lm-banner-error flex-col gap-2">
            <p>{setup.message}</p>
            <div className="flex flex-wrap gap-2">
              {setup.retryable && (
                <button
                  type="button"
                  onClick={() => void start()}
                  className={buttonClass('secondary', 'sm', 'min-h-11')}
                >
                  <Icon name="refresh" size={16} />
                  Try again
                </button>
              )}
              {setup.upgrade && (
                <Link
                  href="/pricing"
                  className={buttonClass('ghost', 'sm', 'min-h-11 text-[var(--color-ink)]')}
                >
                  See plans
                </Link>
              )}
            </div>
          </div>
        )}

        {/* The zone is usable immediately; files queue until the draft exists. */}
        <GalleryUploader
          key={mode}
          galleryId={galleryId}
          mode={mode}
          api={api}
          signInHref={
            galleryId
              ? authUrlForPublish(galleryId, returnTo)
              : `/auth?returnTo=${encodeURIComponent(returnTo)}`
          }
        />

        {galleryId && (
          <div className="sticky bottom-0 -mx-4 mt-auto border-t border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
            <PublishButton
              galleryId={galleryId}
              signedIn={signedIn}
              isGuestDraft={!signedIn}
              returnTo={returnTo}
            />
          </div>
        )}
      </main>
    </div>
  );
}
