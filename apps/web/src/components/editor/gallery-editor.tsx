'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EditorMediaItem, GalleryDetail, MediaStatus } from '@lumra/contracts';
import { PublishButton } from '@/components/publish-button';
import {
  deleteGalleryRequest,
  deleteMediaRequest,
  getGalleryRequest,
  localInputToUtcIso,
  reorderMediaRequest,
  setPasswordRequest,
  updateGalleryRequest,
  utcIsoToLocalInput,
} from '@/lib/editor-client';
import { AppHeader, Icon, Tag, buttonClass } from '@/components/ui';
import { UploadBridgeContext } from '@/components/upload';
import { ConfirmDialog } from './confirm-dialog';
import { MediaGrid, moveItem } from './media-grid';
import { ShareSheet } from './share-sheet';
import { THUMBNAIL_RETRY_MS, mergeThumbnails, useLocalPreviews } from './thumbnails';

const IN_FLIGHT: readonly MediaStatus[] = ['reserved', 'uploading', 'uploaded', 'processing'];
const POLL_MS = 5_000;

/** Aside section: stacked on phones, separated by hairlines in the settings panel. */
const card =
  'flex flex-col gap-3 border-b border-[var(--color-hairline)] pb-5 last:border-b-0 last:pb-0';
const field = 'lm-input';
const secondary = buttonClass('secondary', 'md', 'min-h-11');
const primary = buttonClass('primary', 'md', 'min-h-11');
const heading = 'lm-title-2';

const STATE_LABEL = { draft: 'Draft', published: 'Published', expired: 'Expired' } as const;

/**
 * Owner gallery editor (T15/T16/T19/T21, PRD §4 `/dashboard/galleries/[id]`). Server state comes
 * from the editor API; edits are applied optimistically where safe (order) and reconciled from
 * the server response. `uploadSlot` is where the upload zone (T14) mounts.
 */
export function GalleryEditor({
  initial,
  uploadSlot,
}: {
  initial: GalleryDetail;
  /** Upload zone (T14). Until it lands, a placeholder explains that uploads start from `/new`. */
  uploadSlot?: ReactNode;
}) {
  const router = useRouter();
  const [gallery, setGallery] = useState(initial);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const galleryId = gallery.id;

  const announce = useCallback((message: string) => {
    setAnnouncement('');
    // Re-set on the next tick so repeated identical messages are still announced.
    setTimeout(() => setAnnouncement(message), 10);
  }, []);

  // Thumbnails whose gateway URL failed to load: take the next response's fresh URL.
  const staleThumbnails = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const stale = new Set(staleThumbnails.current);
    staleThumbnails.current.clear();
    const res = await getGalleryRequest(galleryId);
    if (res.ok) setGallery((prev) => mergeThumbnails(prev, res.data, stale));
    else for (const id of stale) staleThumbnails.current.add(id);
    return res;
  }, [galleryId]);

  // Coalesces refetches requested by failing thumbnails and new uploads.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 300);
  }, [refresh]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const thumbnailRetries = useRef(new Map<string, number>());
  const onThumbnailError = useCallback(
    (mediaId: string) => {
      const now = Date.now();
      const last = thumbnailRetries.current.get(mediaId);
      if (last !== undefined && now - last < THUMBNAIL_RETRY_MS) return;
      thumbnailRetries.current.set(mediaId, now);
      staleThumbnails.current.add(mediaId);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const knownIds = useMemo(() => new Set(gallery.items.map((i) => i.id)), [gallery.items]);
  const { bridge, previews } = useLocalPreviews(knownIds, scheduleRefresh);

  // ---------------------------------------------------------------- order (serialised saves)
  const saving = useRef<{ inFlight: boolean; pending: string[] | null }>({
    inFlight: false,
    pending: null,
  });

  const saveOrder = useCallback(
    async (orderedIds: string[]) => {
      const s = saving.current;
      if (s.inFlight) {
        s.pending = orderedIds; // latest wins
        return;
      }
      s.inFlight = true;
      let next: string[] | null = orderedIds;
      while (next) {
        s.pending = null;
        const res = await reorderMediaRequest(galleryId, next);
        if (!res.ok) {
          s.pending = null;
          setError(res.message);
          announce(res.message);
          await refresh();
          break;
        }
        setGallery((g) => ({ ...g, contentVersion: res.data.contentVersion }));
        next = s.pending;
      }
      s.inFlight = false;
    },
    [announce, galleryId, refresh],
  );

  function move(from: number, to: number) {
    const items = moveItem(gallery.items, from, to);
    const moved = gallery.items[from];
    if (!moved || from === to) return;
    setGallery((g) => ({ ...g, items }));
    announce(`Moved ${moved.filename} to position ${to + 1} of ${items.length}.`);
    void saveOrder(items.map((i) => i.id));
  }

  // ---------------------------------------------------------------- polling for readiness
  const hasInFlight = gallery.items.some((i) => IN_FLIGHT.includes(i.status));
  useEffect(() => {
    if (!hasInFlight) return;
    const timer = setInterval(() => {
      if (!saving.current.inFlight && document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasInFlight, refresh]);

  // ---------------------------------------------------------------- title
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(gallery.title);
  const [busy, setBusy] = useState<string | null>(null);

  async function patch(body: Parameters<typeof updateGalleryRequest>[1], done: string) {
    setError(null);
    const res = await updateGalleryRequest(galleryId, body);
    if (!res.ok) {
      setError(res.message);
      announce(res.message);
      return false;
    }
    setGallery((prev) => mergeThumbnails(prev, res.data));
    announce(done);
    return true;
  }

  async function saveTitle() {
    const title = titleDraft.trim();
    if (!title) {
      setError('Title can’t be empty.');
      return;
    }
    setBusy('title');
    if (await patch({ title }, 'Title saved.')) setEditingTitle(false);
    setBusy(null);
  }

  // ---------------------------------------------------------------- cover / delete media
  async function setCover(mediaId: string | null) {
    setBusy('cover');
    await patch({ coverMediaId: mediaId }, mediaId ? 'Cover updated.' : 'Cover set to automatic.');
    setBusy(null);
  }

  const [toDelete, setToDelete] = useState<EditorMediaItem | null>(null);
  async function confirmDeleteMedia() {
    if (!toDelete) return;
    setBusy('media');
    const res = await deleteMediaRequest(galleryId, toDelete.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      announce(res.message);
    } else {
      setGallery((g) => ({
        ...g,
        items: g.items.filter((i) => i.id !== toDelete.id),
        itemCount: g.itemCount - 1,
        coverMediaId: res.data.coverMediaId,
        contentVersion: res.data.contentVersion,
      }));
      announce(`Deleted ${toDelete.filename}.`);
      void refresh();
    }
    setToDelete(null);
  }

  // ---------------------------------------------------------------- publish settings
  const [expiryLocal, setExpiryLocal] = useState(utcIsoToLocalInput(gallery.expiresAt));
  const [publishPassword, setPublishPassword] = useState('');
  const publishExpiry = localInputToUtcIso(expiryLocal);

  async function saveExpiry(value: string | null) {
    setBusy('expiry');
    await patch({ expiresAt: value }, value ? 'Expiry saved.' : 'Expiry removed.');
    setBusy(null);
  }

  // ---------------------------------------------------------------- password
  const [newPassword, setNewPassword] = useState('');
  async function savePassword(password: string | null) {
    setBusy('password');
    setError(null);
    const res = await setPasswordRequest(galleryId, password);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      announce(res.message);
      return;
    }
    setGallery((g) => ({
      ...g,
      hasPassword: res.data.hasPassword,
      accessVersion: res.data.accessVersion,
    }));
    setNewPassword('');
    announce(
      password === null
        ? 'Password removed.'
        : 'Password saved. Anyone who unlocked the gallery before must enter the new password.',
    );
  }

  // ---------------------------------------------------------------- delete gallery
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  async function confirmDeleteGallery() {
    setBusy('gallery');
    const res = await deleteGalleryRequest(galleryId);
    if (!res.ok) {
      setBusy(null);
      setError(res.message);
      announce(res.message);
      return;
    }
    router.push('/dashboard');
    router.refresh();
  }

  const isDraft = gallery.status === 'draft';

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/dashboard', label: 'Galleries' }}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Tag
            tone={gallery.accessState === 'published' ? 'published' : undefined}
            icon={gallery.accessState === 'expired' ? 'clock' : undefined}
            dot={gallery.accessState !== 'expired'}
          >
            {STATE_LABEL[gallery.accessState]}
          </Tag>
          {gallery.hasPassword && (
            <Tag icon="lock" className="hidden sm:inline-flex">
              Password
            </Tag>
          )}
        </span>
      </AppHeader>
      <div className="grid w-full flex-1 lg:grid-cols-[minmax(0,1fr)_var(--panel-width)]">
        <main className="flex min-w-0 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
          <header className="flex flex-col gap-2">
            {editingTitle ? (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle();
                }}
              >
                <label className="lm-field lm-field-label min-w-0 flex-1 basis-72">
                  Gallery title
                  <input
                    autoFocus
                    value={titleDraft}
                    maxLength={200}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setTitleDraft(gallery.title);
                        setEditingTitle(false);
                      }
                    }}
                    className="lm-titleinput"
                  />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className={primary} disabled={busy === 'title'}>
                    Save title
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => {
                      setTitleDraft(gallery.title);
                      setEditingTitle(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 className="lm-title-1 min-w-0 break-words">{gallery.title}</h1>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm', 'min-h-11')}
                  onClick={() => {
                    setTitleDraft(gallery.title);
                    setEditingTitle(true);
                  }}
                >
                  Rename
                </button>
              </div>
            )}
            <p className="lm-num text-[var(--color-ink-muted)]">
              {STATE_LABEL[gallery.accessState]} · {gallery.itemCount}{' '}
              {gallery.itemCount === 1 ? 'photo' : 'photos'}
              {gallery.hasPassword ? ' · Password protected' : ''}
              {gallery.expiresAt
                ? ` · Expires ${new Date(gallery.expiresAt).toLocaleString()}`
                : ''}
            </p>
          </header>

          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
          {error && (
            <p role="alert" className="lm-banner lm-banner-error text-[13px] leading-[18px]">
              {error}
            </p>
          )}

          <section aria-labelledby="add-photos-heading" className="flex flex-col gap-3">
            <h2 id="add-photos-heading" className={heading}>
              Add photos
            </h2>
            <UploadBridgeContext.Provider value={bridge}>
              {uploadSlot ?? (
                <div data-slot="upload-zone" className="lm-drop text-[var(--color-ink-muted)]">
                  Adding photos from the editor arrives with the upload zone (T14).
                </div>
              )}
            </UploadBridgeContext.Provider>
          </section>

          <section aria-labelledby="photos-heading" className="flex flex-col gap-3">
            <h2 id="photos-heading" className={heading}>
              Photos
            </h2>
            <MediaGrid
              items={gallery.items}
              coverMediaId={gallery.coverMediaId}
              effectiveCoverMediaId={gallery.effectiveCoverMediaId}
              disabled={busy === 'cover' || busy === 'media'}
              onMove={move}
              onSetCover={setCover}
              onDelete={setToDelete}
              localPreviews={previews}
              onThumbnailError={onThumbnailError}
            />
          </section>
        </main>

        <aside
          aria-label="Gallery settings"
          className="flex flex-col gap-5 border-t border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-6 sm:px-8 lg:border-t-0 lg:border-l lg:px-6 lg:py-8"
        >
          {gallery.shareUrl && (
            <div className={card}>
              <ShareSheet url={gallery.shareUrl} title={gallery.title} />
            </div>
          )}
          {isDraft ? (
            <section aria-labelledby="publish-heading" className={card}>
              <h2 id="publish-heading" className={heading}>
                Publish
              </h2>
              <p className="lm-field-hint">
                You get the link right away; photos still uploading appear as they finish.
              </p>
              <label className="lm-field lm-field-label w-full">
                Link expires (optional, your local time)
                <input
                  type="datetime-local"
                  value={expiryLocal}
                  onChange={(e) => setExpiryLocal(e.target.value)}
                  className={field}
                />
              </label>
              <label className="lm-field lm-field-label w-full">
                Password (optional, at least 4 characters)
                <input
                  type="password"
                  autoComplete="new-password"
                  value={publishPassword}
                  onChange={(e) => setPublishPassword(e.target.value)}
                  className={field}
                />
              </label>
              <PublishButton
                galleryId={galleryId}
                signedIn
                isGuestDraft={false}
                returnTo={`/dashboard/galleries/${galleryId}`}
                disabled={publishPassword.length > 0 && publishPassword.length < 4}
                settings={{
                  ...(publishExpiry ? { expiresAt: publishExpiry } : {}),
                  ...(publishPassword ? { password: publishPassword } : {}),
                }}
                onPublished={() => {
                  setPublishPassword('');
                  announce('Published. Your share link is ready.');
                  void refresh();
                }}
              />
            </section>
          ) : (
            <section aria-labelledby="access-heading" className={card}>
              <h2 id="access-heading" className={heading}>
                Access
              </h2>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveExpiry(localInputToUtcIso(expiryLocal));
                }}
              >
                <label className="lm-field lm-field-label w-full">
                  Link expires (your local time)
                  <input
                    type="datetime-local"
                    value={expiryLocal}
                    onChange={(e) => setExpiryLocal(e.target.value)}
                    className={field}
                  />
                </label>
                <button
                  type="submit"
                  className={secondary}
                  disabled={busy === 'expiry' || !expiryLocal}
                >
                  Save expiry
                </button>
                {gallery.expiresAt && (
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy === 'expiry'}
                    onClick={() => {
                      setExpiryLocal('');
                      void saveExpiry(null);
                    }}
                  >
                    Never expire
                  </button>
                )}
              </form>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void savePassword(newPassword);
                }}
              >
                <label className="lm-field lm-field-label w-full">
                  {gallery.hasPassword ? 'New password' : 'Password'}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    minLength={4}
                    maxLength={200}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={field}
                  />
                </label>
                <button
                  type="submit"
                  className={secondary}
                  disabled={busy === 'password' || newPassword.length < 4}
                >
                  {gallery.hasPassword ? 'Change password' : 'Set password'}
                </button>
                {gallery.hasPassword && (
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy === 'password'}
                    onClick={() => void savePassword(null)}
                  >
                    Remove password
                  </button>
                )}
              </form>
            </section>
          )}

          <section aria-labelledby="danger-heading" className={card}>
            <h2 id="danger-heading" className={heading}>
              Delete gallery
            </h2>
            <p className="lm-field-hint">
              The link stops working immediately and all photos are permanently removed.
            </p>
            <div>
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmText('');
                  setDeleteOpen(true);
                }}
                className={buttonClass('ghost', 'md', 'lm-btn-danger-text -ml-3 min-h-11')}
              >
                <Icon name="trash" size={18} />
                Delete gallery…
              </button>
            </div>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this photo?"
        confirmLabel="Delete photo"
        busy={busy === 'media'}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void confirmDeleteMedia()}
      >
        <p>
          “{toDelete?.filename}” will be removed from the gallery and its files deleted. This can’t
          be undone.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete “${gallery.title}” permanently?`}
        confirmLabel="Delete permanently"
        busy={busy === 'gallery'}
        confirmDisabled={deleteConfirmText.trim().toLowerCase() !== 'delete'}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDeleteGallery()}
      >
        <p>
          This can’t be undone. The share link stops working right away, and all {gallery.itemCount}{' '}
          photos and any download archives are deleted.
        </p>
        <label className="lm-field lm-field-label">
          Type “delete” to confirm
          <input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            autoComplete="off"
            className={field}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
