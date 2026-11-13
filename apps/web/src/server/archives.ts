import 'server-only';
import { sql } from 'drizzle-orm';
import { ARCHIVE_LIMITS } from '@lumra/config';
import {
  toOutboxRecord,
  type CreateArchiveRequest,
  type CreateArchiveResponse,
} from '@lumra/contracts';
import { archiveJobs, archiveParts, jobOutbox, type Database } from '@lumra/db';
import {
  ARCHIVE_TRANSITIONS,
  assertTransition,
  archiveSourceFingerprint,
  planArchive,
  toPublicArchiveStatus,
  type ArchiveStatus,
} from '@lumra/domain';
import { archivePartKey } from '@lumra/media';
import type { Logger } from '@lumra/observability';
import { ApiFailure } from '@/lib/api';
import {
  findViewableGallery,
  liveGallerySessionExpiry,
  passwordRequiredError,
} from './public-gallery';
import { evaluateAccountAdmission } from './admission';

/**
 * "Download all" archive requests (FR-D02/D03, PRD §10, T24, ADR-003).
 *
 * Authorization is the recipient rule used by every public endpoint (published, not deleted,
 * not expired, and a live gallery session at the current `access_version` when passworded).
 * The job binds the gallery's `content_version` and `access_version`; partitioning and entry
 * names are fixed here, so the worker rebuilds identical bytes on retry. A request for the same
 * content (version + ordered entries) while a job is building — or ready with enough retention
 * left — returns that job instead of starting another build.
 */

export interface CreateArchiveOptions {
  sessionToken?: string;
  /** Opaque requester id (hashed session or hashed client IP), stored for abuse review. */
  requesterHash: string;
  requestId: string;
  log: Logger;
  now?: Date;
}

export interface CreateArchiveResult {
  response: CreateArchiveResponse;
  /** Set for password-protected galleries: copy the session onto the job's paths until then. */
  sessionExpiresAt: Date | null;
}

const REUSABLE_STATUSES: ArchiveStatus[] = ['requested', 'queued', 'running', 'ready'];
const ACTIVE_STATUSES: ArchiveStatus[] = ['requested', 'queued', 'running'];

const unavailableError = () =>
  new ApiFailure({
    code: 'quota_exceeded',
    message: 'Downloading everything at once is temporarily unavailable for this gallery.',
    retryable: false,
    details: { reason: 'archive_unavailable' },
  });

const nothingToDownloadError = () =>
  new ApiFailure({
    code: 'conflict',
    message: 'There are no photos ready to download yet.',
    retryable: true,
    details: { reason: 'no_ready_items' },
  });

const tooManyJobsError = () =>
  new ApiFailure(
    {
      code: 'rate_limited',
      message: 'Several downloads are already being prepared for this gallery. Try again soon.',
      retryable: true,
      details: { reason: 'too_many_active_archives' },
    },
    { 'Retry-After': '60' },
  );

interface ReadyRow extends Record<string, unknown> {
  id: string;
  filename: string;
  mime: string;
  byte_size: string | number;
}

interface GalleryRow extends Record<string, unknown> {
  owner_id: string | null;
  content_version: number;
  access_version: number;
  status: string;
  deleted: boolean;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  status: ArchiveStatus;
  item_count: number;
  parts_expected: number | null;
}

/** `POST /api/v1/public/galleries/{slug}/archives` (permitted viewers only). */
export async function createArchive(
  db: Database,
  slug: string,
  request: CreateArchiveRequest,
  options: CreateArchiveOptions,
): Promise<CreateArchiveResult> {
  const now = options.now ?? new Date();
  const viewable = await findViewableGallery(db, slug, now);
  let sessionExpiresAt: Date | null = null;
  if (viewable.passwordHash) {
    sessionExpiresAt = await liveGallerySessionExpiry(db, viewable, options.sessionToken, now);
    if (!sessionExpiresAt) throw passwordRequiredError();
  }

  const response = await db.transaction(async (tx) => {
    // One archive request per gallery at a time, so concurrent "Download all" clicks share a
    // job; the gallery row itself is not locked (editor writes are not blocked).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`archive:${viewable.id}`}))`);
    const [gallery] = await tx.execute<GalleryRow>(sql`
      select owner_id, content_version, access_version, status,
             (deleted_at is not null) as deleted
      from public.galleries where id = ${viewable.id}::uuid`);
    // Changed since the authorization read (deleted, unpublished, password changed): retry.
    if (
      !gallery ||
      gallery.deleted ||
      gallery.status !== 'published' ||
      gallery.access_version !== viewable.accessVersion
    ) {
      throw new ApiFailure({
        code: 'conflict',
        message: 'This gallery just changed. Reload and try again.',
        retryable: true,
      });
    }

    const ready = await tx.execute<ReadyRow>(sql`
      select id, filename, mime, byte_size
      from public.media
      where gallery_id = ${viewable.id}::uuid and status = 'ready' and deleted_at is null
      order by sort_key collate "C", id`);
    const wanted = request.mediaIds ? new Set(request.mediaIds) : null;
    const items = ready
      .filter((r) => !wanted || wanted.has(r.id))
      .map((r) => ({
        mediaId: r.id,
        filename: r.filename,
        mime: r.mime,
        bytes: Number(r.byte_size),
      }));
    if (items.length === 0) throw nothingToDownloadError();

    const plan = planArchive(items);
    const fingerprint = await archiveSourceFingerprint(plan);
    const reuseUntil = new Date(now.getTime() + ARCHIVE_LIMITS.reuseMinRemainingMs);

    const [existing] = await tx.execute<JobRow>(sql`
      select id, status, item_count, parts_expected
      from public.archive_jobs
      where gallery_id = ${viewable.id}::uuid
        and content_version = ${gallery.content_version}
        and access_version = ${gallery.access_version}
        and source_fingerprint = ${fingerprint}
        and status in (${sql.join(
          REUSABLE_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})
        and (status <> 'ready' or expires_at > ${reuseUntil.toISOString()}::timestamptz)
      order by created_at desc
      limit 1`);
    if (existing) {
      options.log.info('archive reused', { galleryId: viewable.id, jobId: existing.id });
      return {
        jobId: existing.id,
        reused: true,
        status: toPublicArchiveStatus(existing.status),
        itemCount: existing.item_count,
        partsExpected: existing.parts_expected ?? plan.parts.length,
      } satisfies CreateArchiveResponse;
    }

    const [active] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from public.archive_jobs
      where gallery_id = ${viewable.id}::uuid
        and status in (${sql.join(
          ACTIVE_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})`);
    if ((active?.n ?? 0) >= ARCHIVE_LIMITS.maxActiveJobsPerGallery) throw tooManyJobsError();

    // Billing status (PRD §9.4): past-due/canceled owners. Archives are never capped (ADR-008).
    if (gallery.owner_id) {
      const decision = await evaluateAccountAdmission(
        tx,
        gallery.owner_id,
        { kind: 'archive', bytes: plan.totalBytes },
        now,
      );
      if (!decision.allowed) {
        // The recipient sees a neutral notice; the owner's billing state is not disclosed.
        options.log.warn('archive denied by admission', {
          galleryId: viewable.id,
          reason: decision.reason,
        });
        throw unavailableError();
      }
    }

    const jobId = crypto.randomUUID();
    assertTransition('archive', ARCHIVE_TRANSITIONS, 'requested', 'queued');
    await tx.insert(archiveJobs).values({
      id: jobId,
      galleryId: viewable.id,
      requestedBySessionHash: options.requesterHash,
      contentVersion: gallery.content_version,
      accessVersion: gallery.access_version,
      sourceFingerprint: fingerprint,
      // Queued in the same transaction as its outbox row (requested → queued, PRD §7).
      status: 'queued',
      partsExpected: plan.parts.length,
      itemCount: plan.itemCount,
      totalBytes: plan.totalBytes,
    });
    await tx.insert(archiveParts).values(
      plan.parts.map((part) => ({
        jobId,
        partNo: part.partNo,
        objectKey: archivePartKey(viewable.id, jobId, part.partNo),
        entries: part.entries,
        itemCount: part.itemCount,
        sourceBytes: part.sourceBytes,
      })),
    );
    await tx
      .insert(jobOutbox)
      .values(
        toOutboxRecord(
          {
            type: 'archive.build',
            jobId,
            traceId: options.requestId,
            dedupeKey: `archive.build:${jobId}`,
          },
          jobId,
        ),
      )
      .onConflictDoNothing({ target: jobOutbox.dedupeKey });

    options.log.info('archive requested', {
      galleryId: viewable.id,
      jobId,
      items: plan.itemCount,
      parts: plan.parts.length,
      bytes: plan.totalBytes,
    });
    return {
      jobId,
      reused: false,
      status: 'preparing',
      itemCount: plan.itemCount,
      partsExpected: plan.parts.length,
    } satisfies CreateArchiveResponse;
  });

  return { response, sessionExpiresAt };
}
