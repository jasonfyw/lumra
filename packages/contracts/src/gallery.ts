import { z } from 'zod';

export const MEDIA_STATUSES = [
  'reserved',
  'uploading',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleting',
  'deleted',
] as const;
export const mediaStatusSchema = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

/** Persisted gallery states. "expired" is computed from `expiresAt` (PRD §7). */
export const GALLERY_STATUSES = ['draft', 'published', 'deleted'] as const;
export const galleryStatusSchema = z.enum(GALLERY_STATUSES);
export type GalleryVisibility = z.infer<typeof galleryStatusSchema>;

export const galleryDtoSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  status: galleryStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  coverMediaId: z.uuid().nullable(),
  itemCount: z.number().int().nonnegative(),
  contentVersion: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type GalleryDTO = z.infer<typeof galleryDtoSchema>;

export const createGalleryRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type CreateGalleryRequest = z.infer<typeof createGalleryRequestSchema>;

export const publishGalleryRequestSchema = z.object({
  expiresAt: z.iso.datetime().nullable().optional(),
  password: z.string().min(4).max(200).optional(),
});
export type PublishGalleryRequest = z.infer<typeof publishGalleryRequestSchema>;

export const reorderMediaRequestSchema = z.object({
  orderedIds: z.array(z.uuid()).min(1).max(2_000),
});
export type ReorderMediaRequest = z.infer<typeof reorderMediaRequestSchema>;
