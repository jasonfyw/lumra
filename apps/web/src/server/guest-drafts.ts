import 'server-only';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { GALLERY_LIMITS, GUEST_LIMITS } from '@lumra/config';
import type { GuestDraftResponse } from '@lumra/contracts';
import { galleries, guestSessions, media, uploadSessions, type Database } from '@lumra/db';
import { generateSlug } from '@lumra/domain';

const UNIQUE_VIOLATION = '23505';
const MAX_SLUG_ATTEMPTS = 3;

export interface CreatedGuestDraft {
  guestSessionId: string;
  galleryId: string;
  expiresAt: Date;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (
    (error as { code?: string })?.code === UNIQUE_VIOLATION || cause?.code === UNIQUE_VIOLATION
  );
}

/**
 * Creates the guest session and its draft gallery in one transaction (FR-A01, FR-A03). Only the
 * capability's HMAC is stored. `expires_at` is fixed at creation (DB clock + 24 h) and is never
 * extended. Slug collisions (≈2^-99 per pair) are retried.
 */
export async function createGuestDraft(
  db: Database,
  input: { capabilityHash: string; rateKeyHash: string | null },
): Promise<CreatedGuestDraft> {
  const ttlSeconds = Math.floor(GUEST_LIMITS.draftTtlMs / 1000);
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(guestSessions)
          .values({
            capabilityHash: input.capabilityHash,
            rateKeyHash: input.rateKeyHash,
            expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
          })
          .returning({ id: guestSessions.id, expiresAt: guestSessions.expiresAt });
        const [gallery] = await tx
          .insert(galleries)
          .values({
            guestSessionId: session!.id,
            slug: generateSlug(),
            title: GALLERY_LIMITS.defaultTitle,
            status: 'draft',
          })
          .returning({ id: galleries.id });
        return {
          guestSessionId: session!.id,
          galleryId: gallery!.id,
          expiresAt: session!.expiresAt,
        };
      });
    } catch (error) {
      if (attempt < MAX_SLUG_ATTEMPTS && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** The guest session's (unclaimed, undeleted) draft gallery, newest first. */
export async function findGuestDraftGallery(db: Database, guestSessionId: string) {
  const [gallery] = await db
    .select({
      id: galleries.id,
      title: galleries.title,
      status: galleries.status,
      createdAt: galleries.createdAt,
    })
    .from(galleries)
    .where(
      and(
        eq(galleries.guestSessionId, guestSessionId),
        isNull(galleries.ownerId),
        isNull(galleries.deletedAt),
      ),
    )
    .orderBy(desc(galleries.createdAt))
    .limit(1);
  return gallery ?? null;
}

/**
 * Draft, quota usage and per-item upload state for `GET /api/v1/guest/drafts/current`. Contains
 * no secrets: no capability, object keys, provider upload ids or URLs.
 */
export async function loadGuestDraft(
  db: Database,
  guestSessionId: string,
): Promise<GuestDraftResponse | null> {
  const [session] = await db
    .select({
      expiresAt: guestSessions.expiresAt,
      reservedFileCount: guestSessions.reservedFileCount,
      reservedBytes: guestSessions.reservedBytes,
    })
    .from(guestSessions)
    .where(eq(guestSessions.id, guestSessionId))
    .limit(1);
  if (!session) return null;
  const gallery = await findGuestDraftGallery(db, guestSessionId);
  if (!gallery) return null;

  const items = await db
    .select({
      id: media.id,
      filename: media.filename,
      mime: media.mime,
      size: media.byteSize,
      status: media.status,
      sortKey: media.sortKey,
      uploadId: uploadSessions.id,
      uploadStatus: uploadSessions.status,
    })
    .from(media)
    .leftJoin(uploadSessions, eq(uploadSessions.id, media.uploadSessionId))
    .where(and(eq(media.galleryId, gallery.id), isNull(media.deletedAt)))
    .orderBy(asc(sql`${media.sortKey} collate "C"`))
    .limit(GALLERY_LIMITS.maxItemsPerGallery);

  return {
    gallery: {
      id: gallery.id,
      title: gallery.title,
      status: gallery.status,
      createdAt: gallery.createdAt.toISOString(),
    },
    draftExpiresAt: session.expiresAt.toISOString(),
    quota: {
      reservedFiles: session.reservedFileCount,
      reservedBytes: session.reservedBytes,
      maxFiles: GUEST_LIMITS.maxFiles,
      maxBytes: GUEST_LIMITS.maxBytes,
    },
    media: items.map((item) => ({
      id: item.id,
      filename: item.filename,
      mime: item.mime,
      size: item.size,
      status: item.status,
      sortKey: item.sortKey,
      uploadId: item.uploadId,
      uploadStatus: item.uploadStatus,
    })),
  };
}
