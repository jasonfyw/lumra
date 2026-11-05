import { GALLERY_LIMITS } from '@lumra/config';
import { z } from 'zod';
import { cursorPageQuerySchema } from './api';

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

/** Gallery password (FR-G04): hashed with Argon2id server-side, never stored or logged. */
export const galleryPasswordSchema = z.string().min(4).max(200);

/**
 * Expiry instant (FR-G05): ISO-8601 in UTC (`…Z`); the UI converts from local time. `null` means
 * the link never expires. "Must be in the future" is checked server-side (`checkGalleryExpiry`).
 */
export const galleryExpiresAtSchema = z.iso.datetime().nullable();

/** `POST /api/v1/galleries/{id}/publish` (T16). Both fields only apply on the first publish. */
export const publishGalleryRequestSchema = z.object({
  expiresAt: galleryExpiresAtSchema.optional(),
  password: galleryPasswordSchema.optional(),
});
export type PublishGalleryRequest = z.infer<typeof publishGalleryRequestSchema>;

/** `PATCH /api/v1/galleries/{id}/media/order` (T15): a full permutation of non-deleted items. */
export const reorderMediaRequestSchema = z.object({
  orderedIds: z.array(z.uuid()).min(1).max(GALLERY_LIMITS.maxItemsPerGallery),
});
export type ReorderMediaRequest = z.infer<typeof reorderMediaRequestSchema>;

/** Dashboard status: persisted state with "expired" derived from `expiresAt` (PRD §7, FR-N01). */
export const GALLERY_LIST_STATUSES = ['draft', 'published', 'expired'] as const;
export const galleryListStatusSchema = z.enum(GALLERY_LIST_STATUSES);
export type GalleryListStatus = z.infer<typeof galleryListStatusSchema>;

/** One row of `GET /api/v1/galleries` (T08). Bytes are integer decimal bytes. */
export const galleryListItemSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  status: galleryListStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  /** Non-deleted media, including items still uploading or processing. */
  itemCount: z.number().int().nonnegative(),
  /** Originals that reached storage (uploaded or later) + variants of non-deleted media. */
  storedBytes: z.number().int().nonnegative(),
  /** Placeholders (always 0) until analytics land in T26. */
  views: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GalleryListItem = z.infer<typeof galleryListItemSchema>;

export const galleryListQuerySchema = cursorPageQuerySchema;
export type GalleryListQuery = z.infer<typeof galleryListQuerySchema>;

export const galleryListResponseSchema = z.object({
  items: z.array(galleryListItemSchema),
  nextCursor: z.string().nullable(),
});
export type GalleryListResponse = z.infer<typeof galleryListResponseSchema>;

/** `POST /api/v1/galleries` result (same shape as a list row). */
export const createGalleryResponseSchema = galleryListItemSchema;
export type CreateGalleryResponse = z.infer<typeof createGalleryResponseSchema>;

/** `Idempotency-Key` header for retryable creates (PRD §10). A UUID per user intent is typical. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_:.-]+$/);

/** `POST /api/v1/guest/drafts/claim` (T07). */
export const claimGuestDraftRequestSchema = z.object({
  galleryId: z.uuid(),
});
export type ClaimGuestDraftRequest = z.infer<typeof claimGuestDraftRequestSchema>;

export const claimGuestDraftResponseSchema = z.object({
  galleryId: z.uuid(),
  claimedAt: z.iso.datetime(),
  /** True when this user had already claimed the draft (idempotent replay). */
  alreadyClaimed: z.boolean(),
  /** Upload sessions still pending; they keep working under the new owner. */
  pendingUploads: z.number().int().nonnegative(),
});
export type ClaimGuestDraftResponse = z.infer<typeof claimGuestDraftResponseSchema>;
