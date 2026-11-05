import { z } from 'zod';
import { ACCEPTED_PHOTO_MIME_TYPES } from '@lumra/config';
import { galleryStatusSchema, mediaStatusSchema } from './gallery';
import { uploadStatusSchema } from './upload';

/** `POST /api/v1/guest/drafts` (FR-A01). The capability itself only travels in the cookie. */
export const createGuestDraftResponseSchema = z.object({
  galleryId: z.uuid(),
  draftExpiresAt: z.iso.datetime(),
});
export type CreateGuestDraftResponse = z.infer<typeof createGuestDraftResponseSchema>;

export const guestDraftMediaSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
  size: z.number().int().positive(),
  status: mediaStatusSchema,
  sortKey: z.string(),
  /** Latest upload intent for this item, for resume (`GET /api/v1/uploads/{id}`). */
  uploadId: z.uuid().nullable(),
  uploadStatus: uploadStatusSchema.nullable(),
});
export type GuestDraftMedia = z.infer<typeof guestDraftMediaSchema>;

/** `GET /api/v1/guest/drafts/current`: draft, quota usage and per-item upload state. */
export const guestDraftResponseSchema = z.object({
  gallery: z.object({
    id: z.uuid(),
    title: z.string(),
    status: galleryStatusSchema,
    createdAt: z.iso.datetime(),
  }),
  draftExpiresAt: z.iso.datetime(),
  quota: z.object({
    reservedFiles: z.number().int().nonnegative(),
    reservedBytes: z.number().int().nonnegative(),
    maxFiles: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
  }),
  media: z.array(guestDraftMediaSchema),
});
export type GuestDraftResponse = z.infer<typeof guestDraftResponseSchema>;
