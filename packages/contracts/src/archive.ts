import { ARCHIVE_LIMITS, GALLERY_LIMITS } from '@lumra/config';
import { z } from 'zod';
import { mediaUrlSchema } from './public-gallery';

/**
 * Background "Download all" archives (FR-D02–D04, PRD §10, T24/T25, ADR-003).
 *
 * `POST /api/v1/public/galleries/{slug}/archives` creates (or reuses) a job for a permitted
 * viewer; `GET /api/v1/public/archives/{jobId}` reports progress and, once ready, short-lived
 * gateway download URLs per part. ZIP bytes never pass through the web app.
 */

/** One file inside an archive part, fixed when the job is created (stored as JSON). */
export const archivePartEntrySchema = z.object({
  mediaId: z.uuid(),
  /** Sanitized, collision-free entry name (`@lumra/domain` sanitizeArchiveFilename/dedupe). */
  name: z.string().min(1).max(255),
  /** Original byte size at request time (decimal bytes). */
  bytes: z.number().int().nonnegative(),
});
export type ArchivePartEntry = z.infer<typeof archivePartEntrySchema>;
export const archivePartEntriesSchema = z
  .array(archivePartEntrySchema)
  .max(ARCHIVE_LIMITS.maxItemsPerPart);

/** `POST /api/v1/public/galleries/{slug}/archives`. Omit `mediaIds` for "Download all". */
export const createArchiveRequestSchema = z.object({
  mediaIds: z
    .array(z.uuid())
    .min(1)
    .max(GALLERY_LIMITS.maxItemsPerGallery)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'mediaIds must be unique' })
    .optional(),
});
export type CreateArchiveRequest = z.infer<typeof createArchiveRequestSchema>;

/**
 * What recipients see (PRD §7 archive machine, collapsed): `requested`/`queued` → `preparing`,
 * `running` → `processing`, `ready`, `failed`, and `expired` (retention passed, deleted, or the
 * gallery changed since the archive was built).
 */
export const PUBLIC_ARCHIVE_STATUSES = [
  'preparing',
  'processing',
  'ready',
  'failed',
  'expired',
] as const;
export const publicArchiveStatusSchema = z.enum(PUBLIC_ARCHIVE_STATUSES);
export type PublicArchiveStatus = z.infer<typeof publicArchiveStatusSchema>;

/** Why a job failed; only these codes are ever exposed. */
export const ARCHIVE_FAILURE_CODES = [
  /** The gallery was reordered or a photo removed while building (PRD §11 concurrency). */
  'content_changed',
  /** The gallery was deleted or unpublished while building. */
  'gallery_unavailable',
  /** An original object was missing from storage. */
  'original_missing',
  /** Transient failures exhausted the build attempts. */
  'build_failed',
  /** No progress for `ARCHIVE_LIMITS.stalledAfterMs` (worker lost the job). */
  'stalled',
] as const;
export const archiveFailureCodeSchema = z.enum(ARCHIVE_FAILURE_CODES);
export type ArchiveFailureCode = z.infer<typeof archiveFailureCodeSchema>;

export const createArchiveResponseSchema = z.object({
  jobId: z.uuid(),
  /** true when an existing job for the same content was returned instead of a new one. */
  reused: z.boolean(),
  status: publicArchiveStatusSchema,
  itemCount: z.number().int().positive(),
  partsExpected: z.number().int().positive(),
});
export type CreateArchiveResponse = z.infer<typeof createArchiveResponseSchema>;

export const archivePartStatusSchema = z.object({
  partNo: z.number().int().positive(),
  itemCount: z.number().int().nonnegative(),
  /** Originals in this part (decimal bytes). */
  sourceBytes: z.number().int().nonnegative(),
  /** Final ZIP size once built, else null. */
  byteSize: z.number().int().nonnegative().nullable(),
  ready: z.boolean(),
  /** Download name, e.g. `Autumn (part 2 of 4).zip`. */
  filename: z.string().min(1).max(255),
  /** Gateway URL (`action: 'archive'`, ≤ 5 min) — only for ready parts of a ready archive. */
  downloadUrl: mediaUrlSchema.optional(),
});
export type ArchivePartStatus = z.infer<typeof archivePartStatusSchema>;

/** `GET /api/v1/public/archives/{jobId}`. */
export const archiveStatusResponseSchema = z.object({
  jobId: z.uuid(),
  status: publicArchiveStatusSchema,
  progressPct: z.number().int().min(0).max(100),
  gallery: z.object({ slug: z.string().min(1), title: z.string() }),
  itemCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  partsExpected: z.number().int().nonnegative(),
  parts: z.array(archivePartStatusSchema).max(GALLERY_LIMITS.maxItemsPerGallery),
  /** When a ready archive stops being downloadable. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** When the `downloadUrl`s in `parts` stop working (present only when any were minted). */
  urlsExpireAt: z.iso.datetime({ offset: true }).optional(),
  failureCode: archiveFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ArchiveStatusResponse = z.infer<typeof archiveStatusResponseSchema>;
