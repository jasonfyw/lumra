import 'server-only';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { checkGalleryCreation } from '@lumra/billing';
import { GALLERY_LIMITS, RATE_CARD_V1, type PlanRates } from '@lumra/config';
import {
  encodeKeysetCursor,
  type GalleryListItem,
  type GalleryListStatus,
  type KeysetCursor,
} from '@lumra/contracts';
import {
  galleries,
  guestSessions,
  plans,
  profiles,
  uploadSessions,
  type Database,
} from '@lumra/db';
import { decideClaim, galleryAccessState, generateSlug, type ClaimDecision } from '@lumra/domain';
import { getDb } from './db';

/**
 * Gallery persistence for the owner dashboard (T08) and the guest claim (T07). Callers have
 * already authenticated the user; every query here is additionally scoped to that user, so a
 * wrong-user request behaves exactly like a missing row (404, concealed).
 * Business rules come from `@lumra/domain` (claim, access state, slug) and `@lumra/billing`
 * (gallery cap) — nothing is re-implemented here.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Statuses whose original object has reached R2 (counts toward stored bytes). */
const STORED_ORIGINAL_STATUSES = ['uploaded', 'processing', 'ready'] as const;

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

interface ListRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'deleted';
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  cursor_ts: string;
  item_count: number | string;
  stored_bytes: number | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function listStatus(row: Pick<ListRow, 'status' | 'expires_at'>, now: Date): GalleryListStatus {
  const state = galleryAccessState(
    { status: row.status, expiresAt: row.expires_at ? new Date(row.expires_at) : null },
    now,
  );
  // Deleted rows are filtered out by the query; map defensively to draft rather than throw.
  return state === 'deleted' ? 'draft' : state;
}

export interface GalleryPage {
  items: GalleryListItem[];
  nextCursor: string | null;
}

async function queryListRows(
  db: Database,
  ownerId: string,
  filter: { limit: number; cursor?: KeysetCursor | null; galleryId?: string },
): Promise<ListRow[]> {
  const { cursor, galleryId, limit } = filter;
  const after = cursor
    ? sql`and (g.updated_at, g.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
  const only = galleryId ? sql`and g.id = ${galleryId}::uuid` : sql``;
  const storedStatuses = sql.join(
    STORED_ORIGINAL_STATUSES.map((s) => sql`${s}::public.media_status`),
    sql`, `,
  );
  const rows = await db.execute<ListRow>(sql`
    select g.id, g.slug, g.title, g.status, g.expires_at, g.created_at, g.updated_at,
           to_char(g.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts,
           coalesce(m.item_count, 0) as item_count,
           (coalesce(m.original_bytes, 0) + coalesce(v.variant_bytes, 0))::bigint as stored_bytes
    from public.galleries g
    left join lateral (
      select count(*)::int as item_count,
             coalesce(sum(md.byte_size) filter (where md.status in (${storedStatuses})), 0)::bigint
               as original_bytes
      from public.media md
      where md.gallery_id = g.id and md.deleted_at is null
    ) m on true
    left join lateral (
      select coalesce(sum(mv.byte_size), 0)::bigint as variant_bytes
      from public.media_variants mv
      join public.media mm on mm.id = mv.media_id
      where mm.gallery_id = g.id and mm.deleted_at is null
    ) v on true
    where g.owner_id = ${ownerId}::uuid and g.deleted_at is null ${only} ${after}
    order by g.updated_at desc, g.id desc
    limit ${limit}
  `);
  return rows as unknown as ListRow[];
}

function toListItem(row: ListRow, now: Date): GalleryListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: listStatus(row, now),
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    itemCount: Number(row.item_count),
    storedBytes: Number(row.stored_bytes),
    views: 0, // TODO(T26): analytics aggregates
    downloads: 0, // TODO(T26)
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Owner's non-deleted galleries, `updated_at DESC, id DESC`, keyset-paginated (FR-N01). */
export async function listGalleriesForOwner(
  ownerId: string,
  options: { limit: number; cursor: KeysetCursor | null; now?: Date },
  db: Database = getDb(),
): Promise<GalleryPage> {
  const now = options.now ?? new Date();
  const rows = await queryListRows(db, ownerId, {
    limit: options.limit + 1,
    cursor: options.cursor,
  });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => toListItem(row, now)),
    nextCursor:
      rows.length > options.limit && last
        ? encodeKeysetCursor({ ts: last.cursor_ts, id: last.id })
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// plan + cap helpers
// ---------------------------------------------------------------------------------------------

/**
 * Locks the user's profile row so concurrent creates/claims for one user serialise on the
 * gallery-cap check, and returns the plan's rates from the `plans` table.
 */
async function lockPlanRates(tx: Tx, userId: string): Promise<PlanRates> {
  const [row] = await tx
    .select({ plan: plans })
    .from(profiles)
    .innerJoin(plans, eq(plans.id, profiles.planId))
    .where(eq(profiles.userId, userId))
    .for('update', { of: profiles });
  if (!row) return RATE_CARD_V1.free; // handle_new_user always creates one; be conservative.
  const p = row.plan;
  return {
    id: p.id,
    rateVersion: p.rateVersion,
    monthlyFeeMicroUsd: p.monthlyFeeMicroUsd,
    maxActiveGalleries: p.maxActiveGalleries,
    maxStorageBytes: p.maxStorageBytes,
    maxDeliveryBytesPerMonth: p.maxDeliveryBytesPerMonth,
    includedStorageGbMonth: p.includedStorageGbMonth,
    includedDeliveryGb: p.includedDeliveryGb,
    storageOverageMicroUsdPerGbMonth: p.storageOverageMicroUsdPerGbMonth,
    deliveryOverageMicroUsdPerGb: p.deliveryOverageMicroUsdPerGb,
    defaultOverageCapMicroUsd: p.defaultOverageCapMicroUsd,
    brandingVisible: p.brandingVisible,
  };
}

async function activeGalleryCount(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(galleries)
    .where(and(eq(galleries.ownerId, userId), isNull(galleries.deletedAt)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic gallery id for an `Idempotency-Key`: SHA-256(userId, key) shaped as a UUID
 * (version 8, RFC 9562 "custom"). A replay maps to the same primary key, so no extra
 * idempotency table is needed and keys are naturally scoped per user.
 */
export async function idempotentGalleryId(userId: string, key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gallery:${userId}:${key}`)),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80; // version 8
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CreateGalleryResult =
  | { kind: 'created'; gallery: GalleryListItem }
  | { kind: 'replayed'; gallery: GalleryListItem }
  | { kind: 'conflict' }
  | { kind: 'quota_exceeded'; maxActiveGalleries: number | null };

function newGalleryItem(row: typeof galleries.$inferSelect, now: Date): GalleryListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: listStatus({ status: row.status, expires_at: row.expiresAt }, now),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    itemCount: 0,
    storedBytes: 0,
    views: 0,
    downloads: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createGalleryForOwner(
  ownerId: string,
  input: { title?: string; idempotencyKey?: string },
  db: Database = getDb(),
): Promise<CreateGalleryResult> {
  const now = new Date();
  const id = input.idempotencyKey
    ? await idempotentGalleryId(ownerId, input.idempotencyKey)
    : undefined;

  return db.transaction(async (tx) => {
    const plan = await lockPlanRates(tx, ownerId);

    if (id) {
      // Checked after the profile lock, so two concurrent replays can't both insert.
      const [existing] = await tx.select().from(galleries).where(eq(galleries.id, id));
      if (existing) {
        // The key is per-user by construction; a deleted gallery can't be "replayed".
        if (existing.ownerId !== ownerId || existing.deletedAt) return { kind: 'conflict' };
        const [row] = await queryListRows(tx as unknown as Database, ownerId, {
          limit: 1,
          galleryId: id,
        });
        return {
          kind: 'replayed',
          gallery: row ? toListItem(row, now) : newGalleryItem(existing, now),
        };
      }
    }

    const decision = checkGalleryCreation({
      plan,
      activeGalleryCount: await activeGalleryCount(tx, ownerId),
    });
    if (!decision.allowed) {
      return { kind: 'quota_exceeded', maxActiveGalleries: plan.maxActiveGalleries };
    }

    const [row] = await tx
      .insert(galleries)
      .values({
        ...(id ? { id } : {}),
        ownerId,
        slug: generateSlug(),
        title: input.title ?? GALLERY_LIMITS.defaultTitle,
      })
      .returning();
    return { kind: 'created', gallery: newGalleryItem(row!, now) };
  });
}

// ---------------------------------------------------------------------------------------------
// claim (T07)
// ---------------------------------------------------------------------------------------------

export type ClaimResult =
  | { kind: 'claimed'; claimedAt: Date; pendingUploads: number }
  | { kind: 'already_claimed'; claimedAt: Date; pendingUploads: number }
  | { kind: 'not_found'; reason: Extract<ClaimDecision, { kind: 'not_found' }>['reason'] }
  | { kind: 'quota_exceeded'; maxActiveGalleries: number | null };

async function pendingUploadCount(tx: Tx, galleryId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.galleryId, galleryId), eq(uploadSessions.status, 'pending')));
  return row?.n ?? 0;
}

/**
 * Transfers a guest draft to `userId` in one transaction (ADR-005):
 * lock guest session → lock gallery → decide (domain) → re-check the plan's gallery cap →
 * set `owner_id`/`claimed_at` (guest_session_id stays as provenance, per the ownership CHECK) →
 * mark the guest session claimed.
 *
 * Media and upload sessions hang off the gallery, so they follow the ownership change without
 * being rewritten: in-flight uploads keep their ids, keys and reservations and continue under
 * the new owner (T10 authorizes them through the gallery).
 */
export async function claimGuestDraft(
  input: { userId: string; galleryId: string; guestSessionId: string | null; now?: Date },
  db: Database = getDb(),
): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<ClaimResult> => {
    const [session] = input.guestSessionId
      ? await tx
          .select({
            id: guestSessions.id,
            expiresAt: guestSessions.expiresAt,
            claimedByUserId: guestSessions.claimedByUserId,
            claimedAt: guestSessions.claimedAt,
          })
          .from(guestSessions)
          .where(eq(guestSessions.id, input.guestSessionId))
          .for('update')
      : [];
    const [gallery] = await tx
      .select({
        ownerId: galleries.ownerId,
        guestSessionId: galleries.guestSessionId,
        claimedAt: galleries.claimedAt,
        deletedAt: galleries.deletedAt,
      })
      .from(galleries)
      .where(eq(galleries.id, input.galleryId))
      .for('update');

    const decision = decideClaim({
      userId: input.userId,
      gallery: gallery ?? null,
      guestSession: session ?? null,
      now,
    });
    if (decision.kind === 'not_found') return decision;
    if (decision.kind === 'already_claimed') {
      return {
        kind: 'already_claimed',
        claimedAt: decision.claimedAt,
        pendingUploads: await pendingUploadCount(tx, input.galleryId),
      };
    }

    const plan = await lockPlanRates(tx, input.userId);
    const cap = checkGalleryCreation({
      plan,
      activeGalleryCount: await activeGalleryCount(tx, input.userId),
    });
    if (!cap.allowed)
      return { kind: 'quota_exceeded', maxActiveGalleries: plan.maxActiveGalleries };

    await tx
      .update(galleries)
      .set({ ownerId: input.userId, claimedAt: now })
      .where(and(eq(galleries.id, input.galleryId), isNull(galleries.ownerId)));
    await tx
      .update(guestSessions)
      .set({ claimedByUserId: input.userId, claimedAt: now })
      .where(eq(guestSessions.id, session!.id));

    return {
      kind: 'claimed',
      claimedAt: now,
      pendingUploads: await pendingUploadCount(tx, input.galleryId),
    };
  });
}

/** Minimal ownership facts for the post-sign-in resume screen (no content is revealed). */
export async function getClaimTarget(
  galleryId: string,
  db: Database = getDb(),
): Promise<{ ownerId: string | null; guestSessionId: string | null; claimed: boolean } | null> {
  const [row] = await db
    .select({
      ownerId: galleries.ownerId,
      guestSessionId: galleries.guestSessionId,
      claimedAt: galleries.claimedAt,
    })
    .from(galleries)
    .where(and(eq(galleries.id, galleryId), isNull(galleries.deletedAt)));
  return row
    ? { ownerId: row.ownerId, guestSessionId: row.guestSessionId, claimed: row.claimedAt !== null }
    : null;
}
