import { z } from 'zod';
import { ACCEPTED_PHOTO_MIME_TYPES, UPLOAD_LIMITS } from '@lumra/config';

export const uploadIntentRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  mime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
  size: z.number().int().positive().max(UPLOAD_LIMITS.maxPhotoBytes),
  /** UUID per client file, stable across retries; doubles as idempotency key. */
  clientId: z.uuid(),
});
export type UploadIntentRequest = z.infer<typeof uploadIntentRequestSchema>;

export const uploadIntentResponseSchema = z.object({
  mediaId: z.uuid(),
  intentId: z.uuid(),
  multipart: z.boolean(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
});
export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;

export const signPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});
export type SignPartsRequest = z.infer<typeof signPartsRequestSchema>;

export const completeUploadRequestSchema = z.object({
  parts: z.array(z.object({ number: z.number().int().min(1), etag: z.string().min(1) })),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'expected hex SHA-256')
    .optional(),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

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
