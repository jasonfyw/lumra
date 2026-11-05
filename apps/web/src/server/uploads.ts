import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  BILLING_POLICY_V1,
  GALLERY_LIMITS,
  GUEST_LIMITS,
  UPLOAD_LIMITS,
  type PlanId,
  type PlanRates,
} from '@lumra/config';
import type {
  AbortUploadResponse,
  ApiError,
  CompleteUploadRequest,
  CompleteUploadResponse,
  MediaStatus,
  SignPartsResponse,
  UploadIntentRequest,
  UploadIntentResponse,
  UploadStateResponse,
} from '@lumra/contracts';
import { checkAdmission, estimateStoredFootprintBytes } from '@lumra/billing';
import {
  billingAccounts,
  galleries,
  jobOutbox,
  media,
  plans,
  profiles,
  uploadSessions,
  type Database,
  type Gallery,
  type Media,
  type UploadSession,
} from '@lumra/db';
import {
  MEDIA_TRANSITIONS,
  canTransition,
  keyBetween,
  sanitizeDownloadFilename,
} from '@lumra/domain';
import {
  R2Error,
  checkCompletePartNumbers,
  isAcceptedExtension,
  normalizeEtag,
  originalKey,
  partLength,
  planFromReservation,
  planUpload,
  type R2Client,
  type UploadPlan,
} from '@lumra/media';
import type { Logger } from '@lumra/observability';
import type { Principals } from '@/lib/actor';
import { ApiFailure, notFoundError, validationError } from '@/lib/api';
import type { Tx } from '@/lib/db';

/**
 * Upload intents, part signing, resume, completion and abort (T10, PRD §6.2, §7, §10, FR-M02..M04).
 * File bytes never pass through here: the browser PUTs straight to R2 with presigned URLs bound
 * to one key, part number, content length (and content type for single PUTs) for ≤15 minutes.
 * See docs/UPLOADS.md for the flow and the verification strategy.
 */

export interface UploadDeps {
  db: Database;
  /** Lazy so intents for single-PUT files never need R2 credentials. */
  r2: () => R2Client;
  log: Logger;
  requestId: string;
}

/** Who holds a gallery's upload quota: the account owner or the guest draft session. */
export type QuotaHolder =
  { kind: 'user'; userId: string } | { kind: 'guest'; guestSessionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_MEDIA: readonly MediaStatus[] = ['reserved', 'uploading'];

const unauthenticated = () =>
  new ApiFailure({
    code: 'unauthenticated',
    message: 'Sign in or start a draft to upload.',
    retryable: false,
  });

const conflict = (message: string, details: Record<string, unknown>, retryable = false) =>
  new ApiFailure({ code: 'conflict', message, retryable, details });

/** Fails fast when the request carries no credential at all (401 instead of a concealed 404). */
export function requirePrincipal(principals: Principals): void {
  if (!principals.user && !principals.guest) throw unauthenticated();
}

/**
 * PRD §6.2 access matrix for upload operations. Account-owned galleries: only the owner. Guest
 * drafts (no owner yet): only the guest session proven by the capability cookie. Deleted
 * galleries are invisible. Returns null (→ concealed 404) when not authorised.
 */
export function authorizeGalleryUpload(
  gallery: Pick<Gallery, 'ownerId' | 'guestSessionId' | 'status' | 'deletedAt'>,
  principals: Principals,
): QuotaHolder | null {
  if (gallery.deletedAt || gallery.status === 'deleted') return null;
  if (gallery.ownerId) {
    return principals.user?.userId === gallery.ownerId
      ? { kind: 'user', userId: gallery.ownerId }
      : null;
  }
  if (gallery.guestSessionId && principals.guest?.guestSessionId === gallery.guestSessionId) {
    return { kind: 'guest', guestSessionId: gallery.guestSessionId };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------

async function reserveGuestQuota(tx: Tx, guestSessionId: string, size: number): Promise<void> {
  const rows = await tx.execute<{ ok: boolean }>(
    sql`select public.reserve_guest_upload(${guestSessionId}::uuid, ${size}::bigint) as ok`,
  );
  if (rows[0]?.ok) return;

  // Explain the refusal (the atomic function only says no).
  const [row] = await tx.execute<{ files: number; bytes: string; live: boolean }>(
    sql`select reserved_file_count as files, reserved_bytes::text as bytes,
               (expires_at > now() and claimed_at is null) as live
        from public.guest_sessions where id = ${guestSessionId}::uuid`,
  );
  if (!row?.live) {
    throw new ApiFailure({
      code: 'unauthenticated',
      message: 'This draft has expired. Sign in to keep uploading.',
      retryable: false,
      details: { reason: 'draft_expired' },
    });
  }
  const reason = row.files + 1 > GUEST_LIMITS.maxFiles ? 'guest_file_limit' : 'guest_byte_limit';
  throw new ApiFailure({
    code: 'quota_exceeded',
    message: 'Guest drafts are limited to 20 photos and 250 MB. Sign in to upload more.',
    retryable: false,
    details: {
      reason,
      requiresAuth: true,
      reservedFiles: row.files,
      reservedBytes: Number(row.bytes),
      maxFiles: GUEST_LIMITS.maxFiles,
      maxBytes: GUEST_LIMITS.maxBytes,
    },
  });
}

function planRatesFromRow(row: typeof plans.$inferSelect): PlanRates {
  return {
    id: row.id as PlanId,
    rateVersion: row.rateVersion,
    monthlyFeeMicroUsd: row.monthlyFeeMicroUsd,
    maxActiveGalleries: row.maxActiveGalleries,
    maxStorageBytes: row.maxStorageBytes,
    maxDeliveryBytesPerMonth: row.maxDeliveryBytesPerMonth,
    includedStorageGbMonth: row.includedStorageGbMonth,
    includedDeliveryGb: row.includedDeliveryGb,
    storageOverageMicroUsdPerGbMonth: row.storageOverageMicroUsdPerGbMonth,
    deliveryOverageMicroUsdPerGb: row.deliveryOverageMicroUsdPerGb,
    defaultOverageCapMicroUsd: row.defaultOverageCapMicroUsd,
    brandingVisible: row.brandingVisible,
  };
}

function calendarMonth(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Plan admission for account-owned galleries (FR-G07, PRD §9.4, T28). Runs inside the intent
 * transaction with the billing account row locked, so concurrent intents for one account are
 * admitted one at a time against the same totals. Stored and pending bytes use the conservative
 * derivative estimate (`estimateStoredFootprintBytes`).
 */
async function admitAccountUpload(tx: Tx, userId: string, size: number, now: Date): Promise<void> {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.userId, userId))
    .for('update');
  const [profile] = await tx
    .select({ planId: profiles.planId })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  const [planRow] = await tx
    .select()
    .from(plans)
    .where(eq(plans.id, profile?.planId ?? 'free'));
  if (!planRow) throw new Error('plan row missing');
  const plan = planRatesFromRow(planRow);

  const period =
    account?.billingPeriodStart && account.billingPeriodEnd
      ? { start: account.billingPeriodStart, end: account.billingPeriodEnd }
      : calendarMonth(now);

  // Committed = objects that exist (or existed and are not yet removed); pending = live intents.
  const [usage] = await tx.execute<{
    committed_bytes: string;
    committed_items: string;
    pending_bytes: string;
    pending_items: string;
  }>(sql`
    select
      coalesce(sum(m.byte_size) filter (where committed), 0)::text as committed_bytes,
      count(*) filter (where committed)::text as committed_items,
      coalesce(sum(m.byte_size) filter (where pending), 0)::text as pending_bytes,
      count(*) filter (where pending)::text as pending_items
    from (
      select m.byte_size,
        (m.status in ('uploaded', 'processing', 'ready')
          or (m.status in ('failed', 'deleting') and us.status = 'completed')) as committed,
        (m.status in ('reserved', 'uploading') and us.status = 'pending'
          and us.expires_at > now()) as pending
      from public.media m
      join public.galleries g on g.id = m.gallery_id
      left join public.upload_sessions us on us.id = m.upload_session_id
      where g.owner_id = ${userId}::uuid and m.status <> 'deleted'
    ) m`);
  const [ledger] = await tx.execute<{ byte_seconds: string; delivery_bytes: string }>(sql`
    select
      coalesce(sum(quantity_micro_units) filter (where metric = 'storage_byte_seconds'), 0)::text
        as byte_seconds,
      coalesce(sum(quantity_micro_units) filter (where metric = 'delivery_bytes'), 0)::text
        as delivery_bytes
    from public.usage_ledger
    where account_id = ${userId}::uuid and period_start = ${period.start.toISOString()}::timestamptz`);

  const decision = checkAdmission({
    plan,
    account: {
      status: account?.status ?? 'free',
      pastDueSince: account?.pastDueSince ?? null,
      restrictedSince: account?.restrictedSince ?? null,
      canceledAt: account?.canceledAt ?? null,
    },
    now,
    period,
    currentUsage: {
      storedBytes: estimateStoredFootprintBytes({
        originalBytes: Number(usage?.committed_bytes ?? 0),
        items: Number(usage?.committed_items ?? 0),
      }),
      storageByteSecondsToDate: BigInt(ledger?.byte_seconds ?? '0'),
      deliveryBytesToDate: Number(ledger?.delivery_bytes ?? 0),
    },
    reservations: [
      {
        kind: 'upload',
        bytes: estimateStoredFootprintBytes({
          originalBytes: Number(usage?.pending_bytes ?? 0),
          items: Number(usage?.pending_items ?? 0),
        }),
      },
    ],
    requested: {
      kind: 'upload',
      bytes: estimateStoredFootprintBytes({ originalBytes: size, items: 1 }),
    },
    capMicroUsd: account?.spendCapMicroUsd ?? null,
    policy: BILLING_POLICY_V1,
  });
  if (decision.allowed) return;

  const details = { reason: decision.reason, remainingCapMicroUsd: decision.remainingCapMicroUsd };
  const error: ApiError =
    decision.reason === 'spend_cap'
      ? {
          code: 'spend_cap_reached',
          message: 'This upload would exceed your spending cap.',
          retryable: false,
          details,
        }
      : decision.reason === 'free_storage_cap' || decision.reason === 'free_delivery_cap'
        ? {
            code: 'quota_exceeded',
            message: 'This upload would exceed your plan’s storage limit.',
            retryable: false,
            details,
          }
        : {
            code: 'forbidden',
            message: 'Uploads are paused for this account. Check your billing status.',
            retryable: false,
            details,
          };
  throw new ApiFailure(error);
}

// ---------------------------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------------------------

function intentResponse(session: UploadSession, item: Media): UploadIntentResponse {
  const plan = planFromReservation(session.reservedBytes, session.partSize);
  return {
    mediaId: item.id,
    intentId: session.id,
    multipart: plan.multipart,
    partSize: plan.partSize,
    partCount: plan.partCount,
    expiresAt: session.expiresAt.toISOString(),
    status: session.status,
    mediaStatus: item.status,
  };
}

/**
 * Reserves quota and creates `media` (status `reserved`, appended at the end of the gallery
 * order) plus its `upload_sessions` row, atomically under the gallery row lock. Idempotent by
 * `clientId`: a retry returns the same intent. Returns `created: false` for a replay.
 */
export async function createUploadIntent(
  deps: UploadDeps,
  principals: Principals,
  galleryId: string,
  input: UploadIntentRequest,
  now = new Date(),
): Promise<{ intent: UploadIntentResponse; created: boolean }> {
  requirePrincipal(principals);
  if (!UUID.test(galleryId)) throw notFoundError('Gallery not found.');
  if (!isAcceptedExtension(input.filename)) {
    throw validationError({ filename: 'unsupported_extension' });
  }
  const plan: UploadPlan = planUpload(input.size);
  const idempotencyKey = `intent:${galleryId}:${input.clientId}`;

  const { session, item, created } = await deps.db.transaction(async (tx) => {
    const [gallery] = await tx
      .select()
      .from(galleries)
      .where(eq(galleries.id, galleryId))
      .for('update');
    const holder = gallery ? authorizeGalleryUpload(gallery, principals) : null;
    if (!gallery || !holder) throw notFoundError('Gallery not found.');

    const [existing] = await tx
      .select({ session: uploadSessions, item: media })
      .from(uploadSessions)
      .innerJoin(media, eq(media.id, uploadSessions.mediaId))
      .where(eq(uploadSessions.idempotencyKey, idempotencyKey));
    if (existing) {
      if (existing.item.byteSize !== input.size || existing.item.mime !== input.mime) {
        throw conflict('clientId was already used for a different file.', {
          reason: 'idempotency_mismatch',
        });
      }
      if (existing.session.status === 'aborted') {
        throw conflict('This upload was cancelled. Start a new one.', { reason: 'aborted' });
      }
      return { ...existing, created: false };
    }

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(media)
      .where(and(eq(media.galleryId, galleryId), isNull(media.deletedAt)));
    if (count >= GALLERY_LIMITS.maxItemsPerGallery) {
      throw new ApiFailure({
        code: 'quota_exceeded',
        message: `A gallery can hold at most ${GALLERY_LIMITS.maxItemsPerGallery} photos.`,
        retryable: false,
        details: { reason: 'gallery_item_limit', max: GALLERY_LIMITS.maxItemsPerGallery },
      });
    }

    let expiresAt: Date;
    if (holder.kind === 'guest') {
      await reserveGuestQuota(tx, holder.guestSessionId, input.size);
      // A guest reservation never outlives its draft (FR-A03).
      expiresAt = principals.guest!.expiresAt;
    } else {
      await admitAccountUpload(tx, holder.userId, input.size, now);
      expiresAt = new Date(now.getTime() + UPLOAD_LIMITS.authReservationTtlMs);
    }

    const [last] = await tx
      .select({ sortKey: media.sortKey })
      .from(media)
      .where(and(eq(media.galleryId, galleryId), isNull(media.deletedAt)))
      .orderBy(desc(sql`${media.sortKey} collate "C"`))
      .limit(1);
    const sortKey = keyBetween(last?.sortKey ?? null, null);

    const mediaId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const ownerOpaqueId = holder.kind === 'user' ? holder.userId : holder.guestSessionId;
    const [item] = await tx
      .insert(media)
      .values({
        id: mediaId,
        galleryId,
        originalKey: originalKey(ownerOpaqueId, galleryId, mediaId),
        filename: sanitizeDownloadFilename(input.filename, 'photo'),
        mime: input.mime,
        byteSize: input.size,
        sortKey,
        status: 'reserved',
      })
      .returning();
    const [session] = await tx
      .insert(uploadSessions)
      .values({
        id: sessionId,
        galleryId,
        mediaId,
        partSize: plan.partSize,
        reservedBytes: input.size,
        expiresAt,
        idempotencyKey,
        guestSessionId: holder.kind === 'guest' ? holder.guestSessionId : null,
      })
      .returning();
    await tx.update(media).set({ uploadSessionId: sessionId }).where(eq(media.id, mediaId));
    return { session: session!, item: { ...item!, uploadSessionId: sessionId }, created: true };
  });

  if (plan.multipart && session.status === 'pending') {
    await ensureMultipartUpload(deps, session, item);
  }
  if (created) {
    deps.log.info('upload intent created', {
      galleryId,
      mediaId: item.id,
      intentId: session.id,
      bytes: input.size,
      multipart: plan.multipart,
      quota: session.guestSessionId ? 'guest' : 'account',
    });
  }
  return { intent: intentResponse(session, item), created };
}

/**
 * Creates the R2 multipart upload outside the DB transaction (no locks held across network
 * calls) and records it once. If a concurrent request won the race, ours is aborted.
 */
async function ensureMultipartUpload(
  deps: UploadDeps,
  session: UploadSession,
  item: Media,
): Promise<string> {
  if (session.providerUploadId) return session.providerUploadId;
  const r2 = deps.r2();
  const { uploadId } = await r2.createMultipartUpload(item.originalKey, item.mime);
  const updated = await deps.db
    .update(uploadSessions)
    .set({ providerUploadId: uploadId })
    .where(
      and(
        eq(uploadSessions.id, session.id),
        isNull(uploadSessions.providerUploadId),
        eq(uploadSessions.status, 'pending'),
      ),
    )
    .returning({ providerUploadId: uploadSessions.providerUploadId });
  if (updated.length) {
    session.providerUploadId = uploadId;
    return uploadId;
  }
  await r2.abortMultipartUpload(item.originalKey, uploadId).catch((err: unknown) => {
    deps.log.warn('failed to abort duplicate multipart upload', { intentId: session.id, err });
  });
  const [row] = await deps.db
    .select({ providerUploadId: uploadSessions.providerUploadId, status: uploadSessions.status })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, session.id));
  if (!row?.providerUploadId || row.status !== 'pending') {
    throw conflict('Upload is no longer pending.', { reason: row?.status ?? 'missing' });
  }
  session.providerUploadId = row.providerUploadId;
  return row.providerUploadId;
}

// ---------------------------------------------------------------------------------------------
// Loading an authorised upload
// ---------------------------------------------------------------------------------------------

interface LoadedUpload {
  session: UploadSession;
  item: Media;
  gallery: Gallery;
  holder: QuotaHolder;
  plan: UploadPlan;
}

/** The upload if `principals` may act on it; otherwise a concealed 404 (PRD §10). */
export async function loadAuthorizedUpload(
  db: Database | Tx,
  principals: Principals,
  uploadId: string,
): Promise<LoadedUpload> {
  requirePrincipal(principals);
  if (!UUID.test(uploadId)) throw notFoundError('Upload not found.');
  const [row] = await db
    .select({ session: uploadSessions, item: media, gallery: galleries })
    .from(uploadSessions)
    .innerJoin(media, eq(media.id, uploadSessions.mediaId))
    .innerJoin(galleries, eq(galleries.id, uploadSessions.galleryId))
    .where(eq(uploadSessions.id, uploadId));
  const holder = row ? authorizeGalleryUpload(row.gallery, principals) : null;
  if (!row || !holder) throw notFoundError('Upload not found.');
  return {
    ...row,
    holder,
    plan: planFromReservation(row.session.reservedBytes, row.session.partSize),
  };
}

function assertWritable(upload: LoadedUpload, now: Date): void {
  const { session, item } = upload;
  if (session.status === 'completed') {
    throw conflict('Upload is already complete.', { reason: 'completed' });
  }
  if (session.status !== 'pending') {
    throw conflict('Upload is no longer active.', { reason: session.status });
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    throw conflict('Upload reservation has expired. Start a new upload.', { reason: 'expired' });
  }
  if (item.deletedAt || !PENDING_MEDIA.includes(item.status)) {
    throw conflict('Upload is no longer active.', { reason: item.status });
  }
}

// ---------------------------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------------------------

/**
 * Presigns PUT URLs for the requested part numbers (TTL ≤ 15 min, fixed `content-length`;
 * single PUTs also pin `content-type`). The first signature moves media `reserved → uploading`.
 */
export async function signUploadParts(
  deps: UploadDeps,
  principals: Principals,
  uploadId: string,
  partNumbers: readonly number[],
  now = new Date(),
): Promise<SignPartsResponse> {
  const upload = await loadAuthorizedUpload(deps.db, principals, uploadId);
  assertWritable(upload, now);
  const { session, item, plan } = upload;

  const unique = [...new Set(partNumbers)].sort((a, b) => a - b);
  const outOfPlan = unique.filter((n) => n < 1 || n > plan.partCount);
  if (outOfPlan.length) {
    throw validationError({ partNumbers: outOfPlan, partCount: plan.partCount });
  }

  if (item.status === 'reserved') {
    await deps.db
      .update(media)
      .set({ status: 'uploading' })
      .where(and(eq(media.id, item.id), eq(media.status, 'reserved')));
  }

  const r2 = deps.r2();
  if (!plan.multipart) {
    const signed = await r2.presignPut(item.originalKey, {
      contentType: item.mime,
      contentLength: item.byteSize,
    });
    return {
      parts: [
        {
          partNumber: 1,
          url: signed.url,
          method: 'PUT',
          headers: signed.headers,
          contentLength: item.byteSize,
          expiresAt: signed.expiresAt.toISOString(),
        },
      ],
    };
  }

  const providerUploadId = await ensureMultipartUpload(deps, session, item);
  const parts = await Promise.all(
    unique.map(async (partNumber) => {
      const contentLength = partLength(plan, item.byteSize, partNumber);
      const signed = await r2.presignUploadPart(
        item.originalKey,
        providerUploadId,
        partNumber,
        undefined,
        contentLength,
      );
      return {
        partNumber,
        url: signed.url,
        method: 'PUT' as const,
        headers: signed.headers,
        contentLength,
        expiresAt: signed.expiresAt.toISOString(),
      };
    }),
  );
  return { parts };
}

// ---------------------------------------------------------------------------------------------
// State (resume)
// ---------------------------------------------------------------------------------------------

const isNoSuchUpload = (err: unknown) => err instanceof R2Error && err.status === 404;

/** Server-side state plus the parts R2 already holds (via ListParts) for resume. No credentials. */
export async function getUploadState(
  deps: UploadDeps,
  principals: Principals,
  uploadId: string,
): Promise<UploadStateResponse> {
  const { session, item, plan } = await loadAuthorizedUpload(deps.db, principals, uploadId);
  let parts: UploadStateResponse['parts'] = [];
  if (plan.multipart && session.status === 'pending' && session.providerUploadId) {
    try {
      const listed = await deps.r2().listParts(item.originalKey, session.providerUploadId);
      parts = listed
        .filter((p) => p.partNumber >= 1 && p.partNumber <= plan.partCount)
        .map((p) => ({ number: p.partNumber, etag: normalizeEtag(p.etag), size: p.size }));
    } catch (err) {
      if (!isNoSuchUpload(err)) throw err;
    }
  }
  return {
    intentId: session.id,
    mediaId: item.id,
    galleryId: session.galleryId,
    status: session.status,
    mediaStatus: item.status,
    size: item.byteSize,
    mime: item.mime,
    multipart: plan.multipart,
    partSize: plan.partSize,
    partCount: plan.partCount,
    expiresAt: session.expiresAt.toISOString(),
    parts,
  };
}

// ---------------------------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------------------------

function completeResponse(
  session: UploadSession,
  mediaStatus: MediaStatus,
): CompleteUploadResponse {
  return { intentId: session.id, mediaId: session.mediaId, status: session.status, mediaStatus };
}

/**
 * Finalises an upload (FR-M04):
 * 1. Multipart: the client's part list must be exactly 1..partCount, and R2's ListParts must
 *    report each part with the planned length and the same ETag; then CompleteMultipartUpload.
 * 2. HEAD the object: it must exist and its size must equal the reservation exactly.
 * 3. One transaction: media `reserved/uploading → uploaded`, session `completed`, the optional
 *    client SHA-256 recorded for the worker to verify, and a `media.uploaded` outbox row with a
 *    dedupe key. Replays return the stored result; nothing is written twice.
 */
export async function completeUpload(
  deps: UploadDeps,
  principals: Principals,
  uploadId: string,
  input: CompleteUploadRequest,
  now = new Date(),
): Promise<CompleteUploadResponse> {
  const upload = await loadAuthorizedUpload(deps.db, principals, uploadId);
  const { session, item, plan } = upload;
  if (session.status === 'completed') return completeResponse(session, item.status);
  assertWritable(upload, now);
  const r2 = deps.r2();

  if (plan.multipart) {
    if (!session.providerUploadId) {
      throw conflict('No parts have been uploaded yet.', { reason: 'no_parts' }, true);
    }
    const problem = checkCompletePartNumbers(
      plan,
      input.parts.map((p) => p.number),
    );
    if (problem) throw validationError({ parts: problem });

    let alreadyCompleted = false;
    try {
      const listed = new Map(
        (await r2.listParts(item.originalKey, session.providerUploadId)).map((p) => [
          p.partNumber,
          p,
        ]),
      );
      const mismatched: number[] = [];
      for (const part of input.parts) {
        const stored = listed.get(part.number);
        if (
          !stored ||
          stored.size !== partLength(plan, item.byteSize, part.number) ||
          normalizeEtag(stored.etag) !== normalizeEtag(part.etag)
        ) {
          mismatched.push(part.number);
        }
      }
      if (mismatched.length) {
        throw conflict(
          'Some parts are missing or differ from what was uploaded. Re-upload them and retry.',
          { reason: 'part_mismatch', partNumbers: mismatched.slice(0, 50) },
          true,
        );
      }
      await r2.completeMultipartUpload(
        item.originalKey,
        session.providerUploadId,
        input.parts.map((p) => ({ partNumber: p.number, etag: p.etag })),
      );
    } catch (err) {
      // NoSuchUpload: a concurrent complete already assembled the object; verify it below.
      if (!isNoSuchUpload(err)) throw err;
      alreadyCompleted = true;
    }
    if (alreadyCompleted) deps.log.info('multipart already completed', { intentId: session.id });
  }

  const head = await r2.headObject(item.originalKey);
  if (!head) {
    throw conflict('The file has not been uploaded yet.', { reason: 'object_missing' }, true);
  }
  if (head.size !== session.reservedBytes) {
    deps.log.warn('upload size mismatch', {
      intentId: session.id,
      expected: session.reservedBytes,
      actual: head.size,
    });
    if (plan.multipart) {
      // The assembled object is wrong; the next sign starts a fresh multipart upload over it.
      await deps.db
        .update(uploadSessions)
        .set({ providerUploadId: null })
        .where(eq(uploadSessions.id, session.id));
    }
    throw conflict(
      'The uploaded file size does not match the reserved size.',
      { reason: 'size_mismatch', expected: session.reservedBytes, actual: head.size },
      true,
    );
  }

  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, session.id))
      .for('update');
    const [current] = await tx.select().from(media).where(eq(media.id, item.id)).for('update');
    if (!locked || !current) throw notFoundError('Upload not found.');
    if (locked.status === 'completed') return completeResponse(locked, current.status);
    if (locked.status !== 'pending' || current.deletedAt) {
      throw conflict('Upload is no longer active.', { reason: locked.status });
    }

    // reserved → uploading → uploaded (PRD §7), validated against the domain state machine.
    let status = current.status;
    if (status === 'reserved' && canTransition(MEDIA_TRANSITIONS, status, 'uploading')) {
      status = 'uploading';
    }
    if (!canTransition(MEDIA_TRANSITIONS, status, 'uploaded')) {
      throw conflict('Upload is no longer active.', { reason: current.status });
    }

    await tx
      .update(media)
      .set({ status: 'uploaded', checksumSha256: input.checksum ?? null, failureCode: null })
      .where(eq(media.id, item.id));
    const [completed] = await tx
      .update(uploadSessions)
      .set({ status: 'completed', completedAt: now })
      .where(eq(uploadSessions.id, session.id))
      .returning();
    const dedupeKey = `media.uploaded:${item.id}`;
    await tx
      .insert(jobOutbox)
      .values({
        eventName: 'media.uploaded',
        aggregateId: item.id,
        payload: { type: 'media.uploaded', mediaId: item.id, traceId: deps.requestId, dedupeKey },
        dedupeKey,
      })
      .onConflictDoNothing({ target: jobOutbox.dedupeKey });

    deps.log.info('upload completed', {
      intentId: session.id,
      mediaId: item.id,
      bytes: head.size,
      multipart: plan.multipart,
      checksumProvided: Boolean(input.checksum),
    });
    return completeResponse(completed!, 'uploaded');
  });
}

// ---------------------------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------------------------

/**
 * Cancels an upload (idempotent): session `aborted`, media `→ deleting` (PRD §7: any non-deleted
 * state may be deleted), the guest reservation released, and a `media.delete` outbox row so the
 * cleanup worker removes any partial object. The R2 multipart upload is aborted best-effort
 * afterwards; the bucket lifecycle rule aborts stragglers after 2 days.
 */
export async function abortUpload(
  deps: UploadDeps,
  principals: Principals,
  uploadId: string,
): Promise<AbortUploadResponse> {
  const upload = await loadAuthorizedUpload(deps.db, principals, uploadId);
  const result = await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, upload.session.id))
      .for('update');
    const [current] = await tx
      .select()
      .from(media)
      .where(eq(media.id, upload.item.id))
      .for('update');
    if (!locked || !current) throw notFoundError('Upload not found.');
    if (locked.status === 'aborted') {
      return { response: completeResponse(locked, current.status), aborted: false };
    }
    if (locked.status === 'completed') {
      throw conflict('Upload is already complete; delete the photo instead.', {
        reason: 'completed',
      });
    }

    let mediaStatus = current.status;
    if (!current.deletedAt && canTransition(MEDIA_TRANSITIONS, current.status, 'deleting')) {
      await tx
        .update(media)
        .set({ status: 'deleting', deletedAt: new Date(), failureCode: 'upload_aborted' })
        .where(eq(media.id, current.id));
      mediaStatus = 'deleting';
    }
    const [aborted] = await tx
      .update(uploadSessions)
      .set({ status: 'aborted' })
      .where(eq(uploadSessions.id, locked.id))
      .returning();
    if (locked.guestSessionId) {
      await tx.execute(
        sql`select public.release_guest_upload(${locked.guestSessionId}::uuid, ${locked.reservedBytes}::bigint)`,
      );
    }
    const dedupeKey = `media.delete:${current.id}`;
    await tx
      .insert(jobOutbox)
      .values({
        eventName: 'media.delete',
        aggregateId: current.id,
        payload: { type: 'media.delete', mediaId: current.id, traceId: deps.requestId, dedupeKey },
        dedupeKey,
      })
      .onConflictDoNothing({ target: jobOutbox.dedupeKey });
    return { response: completeResponse(aborted!, mediaStatus), aborted: true };
  });

  if (result.aborted) {
    deps.log.info('upload aborted', { intentId: upload.session.id, mediaId: upload.item.id });
    if (upload.session.providerUploadId) {
      await deps
        .r2()
        .abortMultipartUpload(upload.item.originalKey, upload.session.providerUploadId)
        .catch((err: unknown) => {
          deps.log.warn('multipart abort failed; lifecycle rule will clean up', {
            intentId: upload.session.id,
            err,
          });
        });
    }
  }
  return result.response;
}
