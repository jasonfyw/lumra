'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { ConfirmDialog } from './confirm-dialog';
import { MediaGrid, moveItem } from './media-grid';
import { ShareSheet } from './share-sheet';

const IN_FLIGHT: readonly MediaStatus[] = ['reserved', 'uploading', 'uploaded', 'processing'];
const POLL_MS = 5_000;

const card =
  'flex flex-col gap-4 rounded-[var(--radius-control)] border border-[var(--color-line)] p-5';
const field =
  'min-h-11 rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 text-base';
const secondary =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-line)] px-4 font-medium disabled:opacity-60';
const primary =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-5 font-medium text-white disabled:opacity-60';

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

  const refresh = useCallback(async () => {
    const res = await getGalleryRequest(galleryId);
    if (res.ok) setGallery(res.data);
    return res;
  }, [galleryId]);

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
    setGallery(res.data);
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
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <nav>
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
        >
          ← Galleries
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        {editingTitle ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveTitle();
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-[var(--color-ink-muted)]">
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
                className={`${field} w-72 max-w-full text-[var(--color-ink)]`}
              />
            </label>
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
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
              {gallery.title}
            </h1>
            <button
              type="button"
              className={secondary}
              onClick={() => {
                setTitleDraft(gallery.title);
                setEditingTitle(true);
              }}
            >
              Rename
            </button>
          </div>
        )}
        <p className="text-[var(--color-ink-muted)]">
          {STATE_LABEL[gallery.accessState]} · {gallery.itemCount}{' '}
          {gallery.itemCount === 1 ? 'photo' : 'photos'}
          {gallery.hasPassword ? ' · Password protected' : ''}
          {gallery.expiresAt ? ` · Expires ${new Date(gallery.expiresAt).toLocaleString()}` : ''}
        </p>
      </header>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {gallery.shareUrl && (
        <div className={card}>
          <ShareSheet url={gallery.shareUrl} title={gallery.title} />
        </div>
      )}

      <section aria-labelledby="add-photos-heading" className="flex flex-col gap-3">
        <h2 id="add-photos-heading" className="text-lg font-semibold">
          Add photos
        </h2>
        {uploadSlot ?? (
          <div
            data-slot="upload-zone"
            className="rounded-[var(--radius-control)] border border-dashed border-[var(--color-line)] p-6 text-[var(--color-ink-muted)]"
          >
            Adding photos from the editor arrives with the upload zone (T14).
          </div>
        )}
      </section>

      <section aria-labelledby="photos-heading" className="flex flex-col gap-3">
        <h2 id="photos-heading" className="text-lg font-semibold">
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
        />
      </section>

      {isDraft ? (
        <section aria-labelledby="publish-heading" className={card}>
          <h2 id="publish-heading" className="text-lg font-semibold">
            Publish
          </h2>
          <p className="text-sm text-[var(--color-ink-muted)]">
            You get the link right away; photos still uploading appear as they finish.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Link expires (optional, your local time)
            <input
              type="datetime-local"
              value={expiryLocal}
              onChange={(e) => setExpiryLocal(e.target.value)}
              className={`${field} w-64 max-w-full`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password (optional, at least 4 characters)
            <input
              type="password"
              autoComplete="new-password"
              value={publishPassword}
              onChange={(e) => setPublishPassword(e.target.value)}
              className={`${field} w-64 max-w-full`}
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
          <h2 id="access-heading" className="text-lg font-semibold">
            Access
          </h2>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveExpiry(localInputToUtcIso(expiryLocal));
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Link expires (your local time)
              <input
                type="datetime-local"
                value={expiryLocal}
                onChange={(e) => setExpiryLocal(e.target.value)}
                className={`${field} w-64 max-w-full`}
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
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void savePassword(newPassword);
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              {gallery.hasPassword ? 'New password' : 'Password'}
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                minLength={4}
                maxLength={200}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`${field} w-64 max-w-full`}
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
        <h2 id="danger-heading" className="text-lg font-semibold">
          Delete gallery
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)]">
          The link stops working immediately and all photos are permanently removed.
        </p>
        <div>
          <button
            type="button"
            onClick={() => {
              setDeleteConfirmText('');
              setDeleteOpen(true);
            }}
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-danger)] px-5 font-medium text-[var(--color-danger)]"
          >
            Delete gallery…
          </button>
        </div>
      </section>

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
        <label className="flex flex-col gap-1 text-sm text-[var(--color-ink)]">
          Type “delete” to confirm
          <input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            autoComplete="off"
            className={field}
          />
        </label>
      </ConfirmDialog>
    </main>
  );
}
