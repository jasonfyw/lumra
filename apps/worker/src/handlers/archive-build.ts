import { ARCHIVE_LIMITS } from '@lumra/config';
import type { ArchiveFailureCode } from '@lumra/contracts';
import type { ArchiveBuildPart, ArchiveRepository } from '@lumra/db';
import { archiveProgressPct } from '@lumra/domain';
import { assertStorageKey, ZipStreamWriter, type Crc32Fn } from '@lumra/media';
import type { Logger } from '../log';

/**
 * `archive.build` (T24, ADR-003): streams one job's parts as STORE-mode ZIPs from the originals
 * bucket into temp-archives via R2 multipart uploads, in the job Worker.
 *
 * - **Bound to content:** the gallery must stay published, undeleted and at the job's
 *   `content_version` (checked before each part, every `contentCheckEvery` entries, and again in
 *   the transaction that records a part / marks the job ready). A reorder or a removed photo
 *   fails the job with `content_changed` instead of serving stale or deleted media (PRD §11).
 * - **Idempotent / resumable:** parts are rebuilt from the entry list fixed at request time, so
 *   a retry produces the same bytes under the same key. Completed parts are skipped; a part
 *   whose build was interrupted is restarted and its abandoned multipart upload aborted.
 * - **One builder at a time:** a lease (`ARCHIVE_LIMITS.leaseMs`) makes a concurrent redelivery
 *   back off instead of racing the same multipart upload.
 * - **Failures:** permanent ones (`content_changed`, `gallery_unavailable`, `original_missing`)
 *   mark the job `failed` at once; transient ones are retried by the queue and become
 *   `build_failed` after `ARCHIVE_LIMITS.maxBuildAttempts` deliveries.
 */

export interface MultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface ArchivesStore {
  createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

export interface ArchiveOriginalsStore {
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

export interface ArchiveBuildDeps {
  repo: ArchiveRepository;
  originals: ArchiveOriginalsStore;
  archives: ArchivesStore;
  log: Logger;
  /** 1-based queue delivery attempt of this message. */
  attempt: number;
  crc32?: Crc32Fn;
  now?: () => number;
  /** Multipart part size; R2 requires ≥ 5 MiB for all but the last part. */
  partBytes?: number;
  /** Re-check the gallery's content version after this many entries. */
  contentCheckEvery?: number;
  /** Minimum time between progress writes. */
  progressIntervalMs?: number;
}

export type ArchiveBuildOutcome =
  'ready' | 'missing' | 'not_buildable' | `failed:${ArchiveFailureCode}`;

/** Another delivery holds the build lease; retry after it can have expired. */
export class RetryLaterError extends Error {
  constructor(
    readonly delaySeconds: number,
    reason: string,
  ) {
    super(reason);
    this.name = 'RetryLaterError';
  }
}

export class ArchiveBuildFailure extends Error {
  constructor(readonly code: ArchiveFailureCode) {
    super(`archive build failed: ${code}`);
    this.name = 'ArchiveBuildFailure';
  }
}

/**
 * Collects the ZIP stream into fixed-size buffers and uploads each as one multipart part, so the
 * Worker holds at most one part (`partBytes`) in memory per build.
 */
class MultipartSink {
  readonly parts: R2UploadedPart[] = [];
  private buffer: Uint8Array;
  private filled = 0;

  constructor(
    private readonly upload: MultipartUpload,
    private readonly partBytes: number,
  ) {
    this.buffer = new Uint8Array(partBytes);
  }

  async write(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const n = Math.min(this.partBytes - this.filled, chunk.byteLength - offset);
      this.buffer.set(chunk.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.partBytes) await this.uploadBuffered();
    }
  }

  private async uploadBuffered(): Promise<void> {
    const body = this.filled === this.partBytes ? this.buffer : this.buffer.slice(0, this.filled);
    const part = await this.upload.uploadPart(this.parts.length + 1, body);
    this.parts.push(part);
    // R2 may still reference the uploaded buffer; never reuse it.
    this.buffer = new Uint8Array(this.partBytes);
    this.filled = 0;
  }

  async finish(): Promise<R2UploadedPart[]> {
    if (this.filled > 0 || this.parts.length === 0) await this.uploadBuffered();
    return this.parts;
  }
}

export async function handleArchiveBuild(
  jobId: string,
  deps: ArchiveBuildDeps,
): Promise<ArchiveBuildOutcome> {
  const { repo, log } = deps;
  const now = deps.now ?? Date.now;
  const claim = await repo.claim(jobId, ARCHIVE_LIMITS.leaseMs);
  if (claim === 'missing') {
    log.warn('archive job not found', { jobId });
    return 'missing';
  }
  if (claim === 'not_buildable') return 'not_buildable';
  if (claim === 'busy') {
    throw new RetryLaterError(Math.ceil(ARCHIVE_LIMITS.leaseMs / 1000), 'archive build lease held');
  }

  try {
    const job = await repo.getJob(jobId);
    if (!job) return 'missing';
    const assertGallery = async () => {
      const state = await repo.galleryState(job.galleryId);
      if (!state?.available) throw new ArchiveBuildFailure('gallery_unavailable');
      if (state.contentVersion !== job.contentVersion) {
        throw new ArchiveBuildFailure('content_changed');
      }
    };
    await assertGallery();

    let doneBytes = job.parts.filter((p) => p.completed).reduce((s, p) => s + p.sourceBytes, 0);
    let lastProgressAt = 0;
    let lastPct = -1;
    const reportProgress = async (bytes: number, force = false) => {
      const pct = archiveProgressPct(bytes, job.totalBytes);
      const t = now();
      if (pct <= lastPct) return;
      if (!force && t - lastProgressAt < (deps.progressIntervalMs ?? 2_000)) return;
      lastPct = pct;
      lastProgressAt = t;
      await repo.setProgress(jobId, pct);
    };

    for (const part of job.parts) {
      if (part.completed) continue;
      await assertGallery();
      const partStart = doneBytes;
      const byteSize = await buildPart(job.galleryId, part, deps, assertGallery, (bytes) =>
        reportProgress(partStart + bytes),
      );
      const recorded = await repo.completePart({
        jobId,
        partId: part.id,
        byteSize,
        contentVersion: job.contentVersion,
      });
      if (!recorded) {
        await assertGallery();
        throw new ArchiveBuildFailure('content_changed');
      }
      doneBytes += part.sourceBytes;
      await reportProgress(doneBytes, true);
      log.info('archive part built', {
        jobId,
        partNo: part.partNo,
        items: part.itemCount,
        byteSize,
      });
    }

    const expiresAt = new Date(now() + ARCHIVE_LIMITS.retentionMs);
    if (!(await repo.markReady(jobId, expiresAt, job.contentVersion))) {
      await assertGallery();
      // Lost a race with a sweep / another terminal transition: nothing left to do.
      return 'not_buildable';
    }
    log.info('archive ready', {
      jobId,
      parts: job.parts.length,
      items: job.parts.reduce((s, p) => s + p.itemCount, 0),
    });
    return 'ready';
  } catch (error) {
    if (error instanceof ArchiveBuildFailure) {
      await repo.markFailed(jobId, error.code);
      log.warn('archive build failed', { jobId, code: error.code });
      return `failed:${error.code}`;
    }
    if (deps.attempt >= ARCHIVE_LIMITS.maxBuildAttempts) {
      await repo.markFailed(jobId, 'build_failed');
      log.error('archive build gave up', { jobId, attempt: deps.attempt, err: error });
      return 'failed:build_failed';
    }
    // Let the queue's retry claim the job immediately.
    await repo.releaseLease(jobId).catch(() => undefined);
    throw error;
  }
}

/** Streams one part into temp-archives; returns the ZIP's byte size. */
async function buildPart(
  galleryId: string,
  part: ArchiveBuildPart,
  deps: ArchiveBuildDeps,
  assertGallery: () => Promise<void>,
  onProgress: (partSourceBytes: number) => Promise<void>,
): Promise<number> {
  const { repo, originals, archives } = deps;
  assertStorageKey(part.objectKey);
  const rows = await repo.media(
    galleryId,
    part.entries.map((e) => e.mediaId),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const entry of part.entries) {
    const row = byId.get(entry.mediaId);
    // Deleting a photo bumps content_version, so this only trips on a racing delete.
    if (!row?.deliverable) throw new ArchiveBuildFailure('content_changed');
    assertStorageKey(row.originalKey);
  }

  if (part.uploadId) {
    // An earlier delivery died mid-part: drop its incomplete upload (best effort; the bucket's
    // lifecycle rule removes abandoned uploads anyway).
    await archives
      .resumeMultipartUpload(part.objectKey, part.uploadId)
      .abort()
      .catch(() => undefined);
  }
  const upload = await archives.createMultipartUpload(part.objectKey, {
    httpMetadata: { contentType: 'application/zip' },
  });
  await repo.setPartUpload(part.id, upload.uploadId);

  const sink = new MultipartSink(upload, deps.partBytes ?? ARCHIVE_LIMITS.uploadPartBytes);
  const writer = new ZipStreamWriter((chunk) => sink.write(chunk), { crc32: deps.crc32 });
  const checkEvery = deps.contentCheckEvery ?? 50;
  let partBytes = 0;
  try {
    for (const [i, entry] of part.entries.entries()) {
      if (i > 0 && i % checkEvery === 0) await assertGallery();
      const row = byId.get(entry.mediaId)!;
      const object = await originals.get(row.originalKey);
      if (!object) throw new ArchiveBuildFailure('original_missing');
      const base = partBytes;
      try {
        await writer.addEntry(
          { name: entry.name, size: object.size, modifiedAt: row.createdAt },
          object.body,
          (n) => void onProgress(base + n).catch(() => undefined),
        );
      } catch (error) {
        await object.body.cancel().catch(() => undefined);
        throw error;
      }
      partBytes += object.size;
    }
    const size = await writer.finish();
    await upload.complete(await sink.finish());
    return size;
  } catch (error) {
    await upload.abort().catch(() => undefined);
    await repo.setPartUpload(part.id, null).catch(() => undefined);
    throw error;
  }
}
