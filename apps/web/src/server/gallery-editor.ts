import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  DeleteGalleryResponse,
  DeleteMediaResponse,
  EditorMediaItem,
  GalleryDetail,
  PublishGalleryRequest,
  PublishGalleryResponse,
  ReorderMediaResponse,
  SetGalleryPasswordResponse,
  UpdateGalleryRequest,
} from '@lumra/contracts';
import {
  galleries,
  jobOutbox,
  media,
  uploadSessions,
  type Database,
  type Gallery,
} from '@lumra/db';
import {
  GALLERY_TRANSITIONS,
  InvalidOrderKeyError,
  MEDIA_TRANSITIONS,
  canTransition,
  checkGalleryExpiry,
  galleryAccessState,
  gallerySharePath,
  reorder,
  selectCover,
} from '@lumra/domain';
import type { Logger } from '@lumra/observability';
import { ApiFailure, notFoundError, validationError } from '@/lib/api';
import type { Tx } from '@/lib/db';
import { hashGalleryPassword } from '@/lib/password';
import { enqueueAccessStateSync } from './access-state';
import { mintOwnerThumbnails, type MintDeps } from './public-gallery';

/**
 * Creator-side gallery editing (T15), publishing (T16) and password/expiry mutations (T19).
 *
 * Every function takes the authenticated owner's user id and treats any other gallery (someone
 * else's, a guest draft, deleted, malformed id) as a concealed 404. Mutations lock the gallery
 * row (`FOR UPDATE`) so concurrent edits of one gallery serialise. Whenever an access-relevant
 * field changes (publish, password, expiry, deletion) a `gallery.access_changed` outbox row is
 * written in the same transaction (ADR-001), and password changes / deletion bump
 * `access_version`, which revokes earlier gallery sessions and media tokens. See
 * docs/GALLERIES.md.
 */

export interface EditorDeps {
  db: Database;
  log: Logger;
  requestId: string;
  /** Absolute app origin used to build share URLs (`NEXT_PUBLIC_APP_URL`). */
  appUrl: string;
  /**
   * Media-token signing for editor thumbnails; null/absent when media delivery isn't configured
   * (thumbnails are then null and the editor shows status tiles).
   */
  media?: Omit<MintDeps, 'now'> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const galleryNotFound = () => notFoundError('Gallery not found.');

function conflict(message: string, details: Record<string, unknown>, retryable = false) {
  return new ApiFailure({ code: 'conflict', message, retryable, details });
}

export function shareUrlFor(appUrl: string, slug: string): string {
  return new URL(gallerySharePath(slug), appUrl).toString();
}

function isOwnedLive(g: Pick<Gallery, 'ownerId' | 'deletedAt' | 'status'>, userId: string) {
  return g.ownerId === userId && !g.deletedAt && g.status !== 'deleted';
}

/** Locks the gallery row, or throws a concealed 404 if the caller doesn't own a live gallery. */
async function lockOwnedGallery(tx: Tx, userId: string, galleryId: string): Promise<Gallery> {
  if (!UUID.test(galleryId)) throw galleryNotFound();
  const [row] = await tx.select().from(galleries).where(eq(galleries.id, galleryId)).for('update');
  if (!row || !isOwnedLive(row, userId)) throw galleryNotFound();
  return row;
}

/** Unlocked ownership pre-check, so non-owners can't make us spend Argon2 CPU. */
async function assertOwned(db: Database, userId: string, galleryId: string): Promise<void> {
  if (!UUID.test(galleryId)) throw galleryNotFound();
  const [row] = await db
    .select({
      ownerId: galleries.ownerId,
      deletedAt: galleries.deletedAt,
      status: galleries.status,
    })
    .from(galleries)
    .where(eq(galleries.id, galleryId));
  if (!row || !isOwnedLive(row, userId)) throw galleryNotFound();
}

function parseExpiry(value: string | null | undefined, now: Date): Date | null | undefined {
  if (value === undefined) return undefined;
  const expiresAt = value === null ? null : new Date(value);
  const check = checkGalleryExpiry(expiresAt, now);
  if (!check.ok) {
    throw validationError({
      expiresAt:
        check.reason === 'in_past'
          ? 'Expiry must be in the future.'
          : 'Expiry must be within 10 years.',
      reason: check.reason,
    });
  }
  return expiresAt;
}

async function enqueueOutbox(
  tx: Tx,
  eventName: 'gallery.delete' | 'media.delete',
  aggregateId: string,
  requestId: string,
) {
  const dedupeKey = `${eventName}:${aggregateId}`;
  const idField = eventName === 'gallery.delete' ? 'galleryId' : 'mediaId';
  await tx
    .insert(jobOutbox)
    .values({
      eventName,
      aggregateId,
      payload: { type: eventName, [idField]: aggregateId, traceId: requestId, dedupeKey },
      dedupeKey,
    })
    .onConflictDoNothing({ target: jobOutbox.dedupeKey });
}

// ---------------------------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

/** Owner's view of a gallery and all its non-deleted items (creator sees every status). */
export async function getGalleryDetail(
  deps: Pick<EditorDeps, 'db' | 'appUrl' | 'media'>,
  userId: string,
  galleryId: string,
  now = new Date(),
): Promise<GalleryDetail> {
  if (!UUID.test(galleryId)) throw galleryNotFound();
  const [g] = await deps.db.select().from(galleries).where(eq(galleries.id, galleryId));
  if (!g || !isOwnedLive(g, userId)) throw galleryNotFound();

  const rows = await deps.db
    .select({
      id: media.id,
      status: media.status,
      filename: media.filename,
      mime: media.mime,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
      sortKey: media.sortKey,
      failureCode: media.failureCode,
      createdAt: media.createdAt,
    })
    .from(media)
    .where(and(eq(media.galleryId, galleryId), isNull(media.deletedAt)))
    .orderBy(sql`${media.sortKey} collate "C"`, media.id);

  // Ownership is verified above, so owner-scoped thumbnail tokens may be minted (ADR-001).
  const thumbnails = deps.media
    ? await mintOwnerThumbnails(
        deps.db,
        g,
        rows.filter((r) => r.status === 'ready').map((r) => r.id),
        deps.media,
        now,
      )
    : new Map<string, string>();
  const items: EditorMediaItem[] = rows.map((r) => ({
    ...r,
    createdAt: iso(r.createdAt),
    thumbnailUrl: thumbnails.get(r.id) ?? null,
  }));
  const cover = selectCover(
    rows.map((r) => ({ id: r.id, status: r.status, uploadOrder: r.createdAt.getTime() })),
    g.coverMediaId,
  );
  const state = galleryAccessState({ status: g.status, expiresAt: g.expiresAt }, now);

  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    status: g.status,
    accessState: state === 'deleted' ? 'draft' : state,
    expiresAt: g.expiresAt ? iso(g.expiresAt) : null,
    publishedAt: g.publishedAt ? iso(g.publishedAt) : null,
    hasPassword: g.passwordHash !== null,
    coverMediaId: g.coverMediaId,
    effectiveCoverMediaId: cover?.id ?? null,
    shareUrl: g.status === 'published' ? shareUrlFor(deps.appUrl, g.slug) : null,
    itemCount: items.length,
    contentVersion: g.contentVersion,
    accessVersion: g.accessVersion,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// PATCH (title / cover / expiry)
// ---------------------------------------------------------------------------------------------

export async function updateGallery(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  input: UpdateGalleryRequest,
  now = new Date(),
): Promise<GalleryDetail> {
  const expiresAt = parseExpiry(input.expiresAt, now);

  await deps.db.transaction(async (tx) => {
    const g = await lockOwnedGallery(tx, userId, galleryId);
    const patch: Partial<typeof galleries.$inferInsert> = {};

    if (input.title !== undefined && input.title !== g.title) patch.title = input.title;

    if (input.coverMediaId !== undefined && input.coverMediaId !== g.coverMediaId) {
      if (input.coverMediaId !== null) {
        const [item] = await tx
          .select({ id: media.id })
          .from(media)
          .where(
            and(
              eq(media.id, input.coverMediaId),
              eq(media.galleryId, galleryId),
              isNull(media.deletedAt),
            ),
          );
        if (!item) {
          throw validationError({ coverMediaId: 'Not a photo in this gallery.' });
        }
      }
      patch.coverMediaId = input.coverMediaId;
    }

    const expiryChanged =
      expiresAt !== undefined &&
      (expiresAt?.getTime() ?? null) !== (g.expiresAt?.getTime() ?? null);
    if (expiryChanged) patch.expiresAt = expiresAt;

    if (Object.keys(patch).length === 0) return;
    await tx.update(galleries).set(patch).where(eq(galleries.id, galleryId));
    // Expiry is access state: the gateway must learn about extensions and shortenings (J4).
    if (expiryChanged) await enqueueAccessStateSync(tx, galleryId, deps.requestId);
    deps.log.info('gallery updated', {
      galleryId,
      fields: Object.keys(patch),
    });
  });

  return getGalleryDetail(deps, userId, galleryId, now);
}

// ---------------------------------------------------------------------------------------------
// publish (T16)
// ---------------------------------------------------------------------------------------------

/**
 * draft → published (FR-G02). Commits regardless of item readiness; `published_at` is set once
 * and the slug never changes. Replays on an already-published gallery are idempotent and leave
 * settings untouched (use PATCH / PUT password to change them).
 */
export async function publishGallery(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  input: PublishGalleryRequest,
  now = new Date(),
): Promise<PublishGalleryResponse> {
  const expiresAt = parseExpiry(input.expiresAt, now);
  await assertOwned(deps.db, userId, galleryId);
  const passwordHash = input.password ? await hashGalleryPassword(input.password) : undefined;

  return deps.db.transaction(async (tx) => {
    const g = await lockOwnedGallery(tx, userId, galleryId);
    if (g.status === 'published') {
      return {
        slug: g.slug,
        shareUrl: shareUrlFor(deps.appUrl, g.slug),
        publishedAt: iso(g.publishedAt!),
        expiresAt: g.expiresAt ? iso(g.expiresAt) : null,
        hasPassword: g.passwordHash !== null,
        alreadyPublished: true,
      };
    }
    if (!canTransition(GALLERY_TRANSITIONS, g.status, 'published')) {
      throw conflict('This gallery cannot be published.', { reason: `from_${g.status}` });
    }

    const [row] = await tx
      .update(galleries)
      .set({
        status: 'published',
        publishedAt: g.publishedAt ?? now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
      })
      .where(eq(galleries.id, galleryId))
      .returning();
    await enqueueAccessStateSync(tx, galleryId, deps.requestId);
    deps.log.info('gallery published', {
      galleryId,
      hasPassword: row!.passwordHash !== null,
      hasExpiry: row!.expiresAt !== null,
    });
    return {
      slug: row!.slug,
      shareUrl: shareUrlFor(deps.appUrl, row!.slug),
      publishedAt: iso(row!.publishedAt!),
      expiresAt: row!.expiresAt ? iso(row!.expiresAt) : null,
      hasPassword: row!.passwordHash !== null,
      alreadyPublished: false,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// password (T19)
// ---------------------------------------------------------------------------------------------

/**
 * Sets, changes or removes the gallery password (FR-G04). Every effective change bumps
 * `access_version`, so previously unlocked gallery sessions and outstanding media tokens stop
 * working (PRD §11). Removing a password that isn't set is a no-op.
 */
export async function setGalleryPassword(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  password: string | null,
): Promise<SetGalleryPasswordResponse> {
  await assertOwned(deps.db, userId, galleryId);
  const passwordHash = password === null ? null : await hashGalleryPassword(password);

  return deps.db.transaction(async (tx) => {
    const g = await lockOwnedGallery(tx, userId, galleryId);
    if (passwordHash === null && g.passwordHash === null) {
      return { hasPassword: false, accessVersion: g.accessVersion };
    }
    const [row] = await tx
      .update(galleries)
      .set({ passwordHash, accessVersion: sql`${galleries.accessVersion} + 1` })
      .where(eq(galleries.id, galleryId))
      .returning({ accessVersion: galleries.accessVersion });
    await enqueueAccessStateSync(tx, galleryId, deps.requestId);
    deps.log.info('gallery password changed', {
      galleryId,
      action: passwordHash === null ? 'removed' : g.passwordHash === null ? 'set' : 'changed',
    });
    return { hasPassword: passwordHash !== null, accessVersion: row!.accessVersion };
  });
}

// ---------------------------------------------------------------------------------------------
// delete gallery (FR-G06)
// ---------------------------------------------------------------------------------------------

/**
 * Immediate, irreversible deletion: in ONE transaction the gallery becomes `deleted`
 * (`deleted_at`), `access_version` is bumped (revoking sessions and tokens), the gateway access
 * state is queued for a tombstone and the asynchronous purge of originals, derivatives and
 * archives is enqueued (deduped). Public reads check `deleted_at` in Postgres, so the gallery is
 * inaccessible as soon as this commits — before the response is sent.
 */
export async function deleteGallery(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  now = new Date(),
): Promise<DeleteGalleryResponse> {
  return deps.db.transaction(async (tx) => {
    await lockOwnedGallery(tx, userId, galleryId);
    await tx
      .update(galleries)
      .set({
        status: 'deleted',
        deletedAt: now,
        accessVersion: sql`${galleries.accessVersion} + 1`,
      })
      .where(eq(galleries.id, galleryId));
    await enqueueAccessStateSync(tx, galleryId, deps.requestId);
    await enqueueOutbox(tx, 'gallery.delete', galleryId, deps.requestId);
    deps.log.info('gallery deleted', { galleryId });
    return { id: galleryId, status: 'deleted', deletedAt: iso(now) };
  });
}

// ---------------------------------------------------------------------------------------------
// reorder (T15)
// ---------------------------------------------------------------------------------------------

/**
 * Applies a full ordering of the gallery's non-deleted items with the minimal set of sort-key
 * updates (`reorder` from @lumra/domain; full rebalance when keys grow too long). The gallery
 * row lock serialises concurrent reorders, appends and deletes, so the result always equals one
 * submitted order. A stale list (an item was added or removed meanwhile) is a retryable 409.
 */
export async function reorderMedia(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  orderedIds: readonly string[],
): Promise<ReorderMediaResponse> {
  return deps.db.transaction(async (tx) => {
    const g = await lockOwnedGallery(tx, userId, galleryId);
    const current = await tx
      .select({ id: media.id, sortKey: media.sortKey })
      .from(media)
      .where(and(eq(media.galleryId, galleryId), isNull(media.deletedAt)))
      .orderBy(sql`${media.sortKey} collate "C"`, media.id);

    const known = new Set(current.map((m) => m.id));
    const isPermutation =
      orderedIds.length === current.length &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => known.has(id));
    if (!isPermutation) {
      throw conflict(
        'The gallery changed while you were reordering. Reload and try again.',
        { reason: 'stale_order', itemCount: current.length },
        true,
      );
    }

    let result: ReturnType<typeof reorder>;
    try {
      result = reorder(current, orderedIds);
    } catch (err) {
      if (!(err instanceof InvalidOrderKeyError)) throw err;
      throw conflict('Could not apply this order.', { reason: 'invalid_order' });
    }
    if (result.updates.length === 0) {
      return { contentVersion: g.contentVersion, updated: 0, rebalanced: false };
    }

    const values = sql.join(
      result.updates.map((u) => sql`(${u.id}::uuid, ${u.sortKey}::text)`),
      sql`, `,
    );
    await tx.execute(sql`
      update public.media m set sort_key = v.sort_key
      from (values ${values}) as v(id, sort_key)
      where m.id = v.id and m.gallery_id = ${galleryId}::uuid and m.deleted_at is null`);
    const [row] = await tx
      .update(galleries)
      .set({ contentVersion: sql`${galleries.contentVersion} + 1` })
      .where(eq(galleries.id, galleryId))
      .returning({ contentVersion: galleries.contentVersion });
    deps.log.info('gallery reordered', {
      galleryId,
      updated: result.updates.length,
      rebalanced: result.rebalanced,
    });
    return {
      contentVersion: row!.contentVersion,
      updated: result.updates.length,
      rebalanced: result.rebalanced,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// delete media (T15)
// ---------------------------------------------------------------------------------------------

/**
 * Removes one item: media → `deleting` (with `deleted_at`, so it leaves the gallery, its count
 * and stored-bytes totals at once), any still-pending upload reservation is released (session
 * aborted; guest quota compensated), the cover override is cleared if it pointed here,
 * `content_version` is bumped and a deduped `media.delete` outbox row asks the worker to purge
 * the original and derivatives.
 */
export async function deleteMedia(
  deps: EditorDeps,
  userId: string,
  galleryId: string,
  mediaId: string,
  now = new Date(),
): Promise<DeleteMediaResponse> {
  if (!UUID.test(mediaId)) throw notFoundError('Photo not found.');
  return deps.db.transaction(async (tx) => {
    const g = await lockOwnedGallery(tx, userId, galleryId);
    const [item] = await tx
      .select()
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.galleryId, galleryId), isNull(media.deletedAt)))
      .for('update');
    if (!item || !canTransition(MEDIA_TRANSITIONS, item.status, 'deleting')) {
      throw notFoundError('Photo not found.');
    }

    await tx.update(media).set({ status: 'deleting', deletedAt: now }).where(eq(media.id, mediaId));

    if (item.uploadSessionId) {
      const [session] = await tx
        .update(uploadSessions)
        .set({ status: 'aborted' })
        .where(
          and(eq(uploadSessions.id, item.uploadSessionId), eq(uploadSessions.status, 'pending')),
        )
        .returning({
          guestSessionId: uploadSessions.guestSessionId,
          reservedBytes: uploadSessions.reservedBytes,
        });
      if (session?.guestSessionId) {
        await tx.execute(
          sql`select public.release_guest_upload(${session.guestSessionId}::uuid, ${session.reservedBytes}::bigint)`,
        );
      }
    }

    const clearCover = g.coverMediaId === mediaId;
    const [row] = await tx
      .update(galleries)
      .set({
        contentVersion: sql`${galleries.contentVersion} + 1`,
        ...(clearCover ? { coverMediaId: null } : {}),
      })
      .where(eq(galleries.id, galleryId))
      .returning({
        contentVersion: galleries.contentVersion,
        coverMediaId: galleries.coverMediaId,
      });
    await enqueueOutbox(tx, 'media.delete', mediaId, deps.requestId);
    deps.log.info('media deleted', { galleryId, mediaId, clearedCover: clearCover });
    return {
      mediaId,
      status: 'deleting',
      contentVersion: row!.contentVersion,
      coverMediaId: row!.coverMediaId,
    };
  });
}
