import 'server-only';
import { asc, eq } from 'drizzle-orm';
import {
  archiveFailureCodeSchema,
  type ArchiveFailureCode,
  type ArchivePartStatus,
  type ArchiveStatusResponse,
  type PublicArchiveStatus,
} from '@lumra/contracts';
import { archiveJobs, archiveParts, galleries, type Database } from '@lumra/db';
import {
  archivePartDownloadName,
  galleryAccessState,
  toPublicArchiveStatus,
  type ArchiveStatus,
} from '@lumra/domain';
import { signMediaToken } from '@lumra/tokens';
import { ApiFailure, notFoundError } from '@/lib/api';
import {
  expiresAtIso,
  gatewayUrl,
  liveGallerySessionExpiry,
  passwordRequiredError,
  type MintDeps,
} from './public-gallery';

/**
 * `GET /api/v1/public/archives/{jobId}` and the `/archive/[jobId]` page (T25, PRD §4/§10).
 *
 * The job id is an unguessable capability, but every read re-checks the gallery exactly like
 * the other public endpoints: published, not deleted (concealed 404), not expired (410), the
 * job's `access_version` still current (a password change orphans the job — 404), and for a
 * passworded gallery a live session at that version (401; the session cookie is scoped to this
 * job's paths when the archive is requested).
 *
 * Download URLs (`action: 'archive'`, ≤ 5 min) are minted only for a ready, unexpired archive
 * whose gallery content is unchanged; the client re-polls to refresh them. They are never logged.
 */

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArchiveStatusOptions {
  sessionToken?: string;
  now?: Date;
}

const expiredError = () =>
  new ApiFailure({
    code: 'gallery_expired',
    message: 'This gallery has expired.',
    retryable: false,
  });

export async function loadArchiveStatus(
  db: Database,
  jobId: string,
  deps: Omit<MintDeps, 'now'> | null,
  options: ArchiveStatusOptions = {},
): Promise<ArchiveStatusResponse> {
  const now = options.now ?? new Date();
  if (!JOB_ID.test(jobId)) throw notFoundError();
  const [row] = await db
    .select({
      job: archiveJobs,
      gallery: {
        id: galleries.id,
        slug: galleries.slug,
        title: galleries.title,
        status: galleries.status,
        deletedAt: galleries.deletedAt,
        expiresAt: galleries.expiresAt,
        passwordHash: galleries.passwordHash,
        accessVersion: galleries.accessVersion,
        contentVersion: galleries.contentVersion,
      },
    })
    .from(archiveJobs)
    .innerJoin(galleries, eq(galleries.id, archiveJobs.galleryId))
    .where(eq(archiveJobs.id, jobId))
    .limit(1);
  if (!row) throw notFoundError();
  const { job, gallery } = row;
  if (gallery.deletedAt) throw notFoundError();
  const access = galleryAccessState({ status: gallery.status, expiresAt: gallery.expiresAt }, now);
  if (access === 'expired') throw expiredError();
  if (access !== 'published') throw notFoundError();
  // Password changed / revoked since the request: the job and its links are gone for everyone.
  if (job.accessVersion !== gallery.accessVersion || job.status === 'deleted') {
    throw notFoundError();
  }
  if (gallery.passwordHash) {
    const session = await liveGallerySessionExpiry(db, gallery, options.sessionToken, now);
    if (!session) throw passwordRequiredError();
  }

  // Past the TTL a ready job reads as expired at once. The row itself is left `ready` for the
  // worker's archive sweep, which owns `ready → expired` together with deleting the ZIP objects
  // (writing it here would hide the job from the sweep and leave the objects to the lifecycle
  // rule, unbilled).
  const ttlPassed = job.status === 'ready' && (!job.expiresAt || job.expiresAt <= now);
  const status: ArchiveStatus = ttlPassed ? 'expired' : job.status;
  // A reorder/removal since the build: the archive no longer matches the gallery (PRD §11).
  const stale = status === 'ready' && job.contentVersion !== gallery.contentVersion;
  const publicStatus: PublicArchiveStatus = stale ? 'expired' : toPublicArchiveStatus(status);

  const parts = await db
    .select({
      id: archiveParts.id,
      partNo: archiveParts.partNo,
      itemCount: archiveParts.itemCount,
      sourceBytes: archiveParts.sourceBytes,
      byteSize: archiveParts.byteSize,
      completedAt: archiveParts.completedAt,
    })
    .from(archiveParts)
    .where(eq(archiveParts.jobId, job.id))
    .orderBy(asc(archiveParts.partNo));

  const partCount = job.partsExpected ?? parts.length;
  const mint = publicStatus === 'ready' && deps !== null;
  const partStatuses: ArchivePartStatus[] = await Promise.all(
    parts.map(async (part) => {
      const filename = archivePartDownloadName(gallery.title, part.partNo, partCount);
      const ready = part.completedAt !== null && part.byteSize !== null;
      const out: ArchivePartStatus = {
        partNo: part.partNo,
        itemCount: part.itemCount,
        sourceBytes: part.sourceBytes,
        byteSize: part.byteSize,
        ready,
        filename,
      };
      if (mint && ready) {
        const token = await signMediaToken(
          {
            action: 'archive',
            gallery_id: gallery.id,
            access_version: gallery.accessVersion,
            archive_part_id: part.id,
            archive_job_id: job.id,
            archive_part_no: part.partNo,
            filename,
          },
          deps.keyring,
          { now },
        );
        out.downloadUrl = gatewayUrl(deps.mediaBaseUrl, token);
      }
      return out;
    }),
  );

  const failure = archiveFailureCodeSchema.safeParse(job.failureCode);
  const failureCode: ArchiveFailureCode | null =
    publicStatus === 'failed' ? (failure.success ? failure.data : 'build_failed') : null;

  const response: ArchiveStatusResponse = {
    jobId: job.id,
    status: publicStatus,
    progressPct: publicStatus === 'ready' ? 100 : publicStatus === 'expired' ? 0 : job.progressPct,
    gallery: { slug: gallery.slug, title: gallery.title },
    itemCount: job.itemCount,
    totalBytes: job.totalBytes,
    partsExpected: partCount,
    parts: partStatuses,
    expiresAt: publicStatus === 'ready' && job.expiresAt ? job.expiresAt.toISOString() : null,
    failureCode,
    createdAt: job.createdAt.toISOString(),
  };
  if (mint && partStatuses.some((p) => p.downloadUrl)) response.urlsExpireAt = expiresAtIso(now);
  return response;
}
