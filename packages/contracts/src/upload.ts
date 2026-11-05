import { z } from 'zod';
import { ACCEPTED_PHOTO_MIME_TYPES, UPLOAD_LIMITS } from '@lumra/config';
import { mediaStatusSchema } from './gallery';

export const uploadIntentRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  mime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
  size: z.number().int().positive().max(UPLOAD_LIMITS.maxPhotoBytes),
  /** UUID per client file, stable across retries; doubles as idempotency key. */
  clientId: z.uuid(),
});
export type UploadIntentRequest = z.infer<typeof uploadIntentRequestSchema>;

/** Persisted upload session states (`upload_session_status`). */
export const UPLOAD_STATUSES = ['pending', 'completed', 'aborted', 'expired'] as const;
export const uploadStatusSchema = z.enum(UPLOAD_STATUSES);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;

export const uploadIntentResponseSchema = z.object({
  mediaId: z.uuid(),
  intentId: z.uuid(),
  multipart: z.boolean(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  status: uploadStatusSchema,
  mediaStatus: mediaStatusSchema,
});
export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;

export const signPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});
export type SignPartsRequest = z.infer<typeof signPartsRequestSchema>;

/**
 * One presigned PUT. The URL is a short-lived bearer credential: never log or persist it. The
 * browser must send `headers` unchanged and a body of exactly `contentLength` bytes.
 */
export const signedPartSchema = z.object({
  partNumber: z.number().int().min(1),
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  contentLength: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
});
export type SignedPart = z.infer<typeof signedPartSchema>;

export const signPartsResponseSchema = z.object({ parts: z.array(signedPartSchema) });
export type SignPartsResponse = z.infer<typeof signPartsResponseSchema>;

/** Server-reported state for resume (no credentials). `parts` lists parts R2 already holds. */
export const uploadStateResponseSchema = z.object({
  intentId: z.uuid(),
  mediaId: z.uuid(),
  galleryId: z.uuid(),
  status: uploadStatusSchema,
  mediaStatus: mediaStatusSchema,
  size: z.number().int().positive(),
  mime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
  multipart: z.boolean(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  parts: z.array(
    z.object({
      number: z.number().int().min(1),
      etag: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
});
export type UploadStateResponse = z.infer<typeof uploadStateResponseSchema>;

export const completeUploadRequestSchema = z.object({
  /** Multipart only: every part with the ETag R2 returned for it. Ignored for single PUTs. */
  parts: z
    .array(z.object({ number: z.number().int().min(1), etag: z.string().min(1).max(130) }))
    .max(UPLOAD_LIMITS.maxPartCount)
    .default([]),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'expected hex SHA-256')
    .optional(),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

export const completeUploadResponseSchema = z.object({
  intentId: z.uuid(),
  mediaId: z.uuid(),
  status: uploadStatusSchema,
  mediaStatus: mediaStatusSchema,
});
export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;

export const abortUploadResponseSchema = completeUploadResponseSchema;
export type AbortUploadResponse = z.infer<typeof abortUploadResponseSchema>;

/**
 * Actionable reasons a photo is rejected by the client pre-check or the authoritative
 * worker sniff (FR-M01, FR-M05, FR-M08). Stored as the media exception class on failure.
 */
export const MEDIA_REJECTION_CODES = [
  'unsupported_extension',
  'empty_file',
  'file_too_large',
  'unsupported_type',
  'truncated',
  'too_many_pixels',
  'heic_unsupported_variant',
  'malformed',
] as const;
export const mediaRejectionCodeSchema = z.enum(MEDIA_REJECTION_CODES);
export type MediaRejectionCode = z.infer<typeof mediaRejectionCodeSchema>;
