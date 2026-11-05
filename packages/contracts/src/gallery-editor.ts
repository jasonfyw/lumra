import { GALLERY_LIMITS } from '@lumra/config';
import { z } from 'zod';
import {
  galleryExpiresAtSchema,
  galleryListStatusSchema,
  galleryPasswordSchema,
  galleryStatusSchema,
  mediaStatusSchema,
} from './gallery';

/**
 * Creator-side gallery editor contracts (T15/T16/T19/T21): `GET/PATCH/DELETE
 * /api/v1/galleries/{id}`, publish, password, media order and media delete. Owner-only; every
 * other caller gets a concealed 404 (PRD §10).
 */

/** One item as the creator sees it: the internal status, including recoverable `failed`. */
export const editorMediaItemSchema = z.object({
  id: z.uuid(),
  status: mediaStatusSchema,
  /** Sanitised original filename (shown to the creator only). */
  filename: z.string(),
  mime: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Fractional ordering key; the array is already sorted by it (code-unit order). */
  sortKey: z.string(),
  /** Machine-readable reason for `failed` items (e.g. `upload_expired`), else null. */
  failureCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * Creator thumbnail via the media gateway. Always null until creator token minting lands
   * (T20); the editor renders a status tile instead.
   */
  thumbnailUrl: z.string().nullable(),
});
export type EditorMediaItem = z.infer<typeof editorMediaItemSchema>;

/** `GET /api/v1/galleries/{id}` result. */
export const galleryDetailSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  /** Persisted state (`deleted` galleries are never returned). */
  status: galleryStatusSchema,
  /** Access state with "expired" computed from `expiresAt` (PRD §7). */
  accessState: galleryListStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  hasPassword: z.boolean(),
  /** Creator override (`galleries.cover_media_id`), or null. */
  coverMediaId: z.uuid().nullable(),
  /** The hero actually shown: override if ready, else first ready by upload order (PRD §4). */
  effectiveCoverMediaId: z.uuid().nullable(),
  /** `{APP_URL}/g/{slug}`; null while the gallery is a draft. */
  shareUrl: z.url().nullable(),
  itemCount: z.number().int().nonnegative(),
  contentVersion: z.number().int().positive(),
  accessVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  items: z.array(editorMediaItemSchema).max(GALLERY_LIMITS.maxItemsPerGallery),
});
export type GalleryDetail = z.infer<typeof galleryDetailSchema>;

/** `PATCH /api/v1/galleries/{id}`: any subset, at least one field. */
export const updateGalleryRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    /** A non-deleted media item of this gallery, or null to restore the automatic hero. */
    coverMediaId: z.uuid().nullable().optional(),
    expiresAt: galleryExpiresAtSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
export type UpdateGalleryRequest = z.infer<typeof updateGalleryRequestSchema>;

export const publishGalleryResponseSchema = z.object({
  slug: z.string(),
  shareUrl: z.url(),
  publishedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  hasPassword: z.boolean(),
  /** True when the gallery was already published (idempotent replay; settings unchanged). */
  alreadyPublished: z.boolean(),
});
export type PublishGalleryResponse = z.infer<typeof publishGalleryResponseSchema>;

/** `PUT /api/v1/galleries/{id}/password`: set/change (string) or remove (null). */
export const setGalleryPasswordRequestSchema = z
  .object({ password: galleryPasswordSchema.nullable() })
  .strict();
export type SetGalleryPasswordRequest = z.infer<typeof setGalleryPasswordRequestSchema>;

export const setGalleryPasswordResponseSchema = z.object({
  hasPassword: z.boolean(),
  /** Bumped on every set/change/remove: earlier gallery sessions and media tokens are revoked. */
  accessVersion: z.number().int().positive(),
});
export type SetGalleryPasswordResponse = z.infer<typeof setGalleryPasswordResponseSchema>;

export const reorderMediaResponseSchema = z.object({
  /** Gallery revision after the change (unchanged when the order already matched). */
  contentVersion: z.number().int().positive(),
  /** Number of rows whose sort key changed (minimal-update reorder). */
  updated: z.number().int().nonnegative(),
  /** True when keys grew too long and every item was re-keyed atomically. */
  rebalanced: z.boolean(),
});
export type ReorderMediaResponse = z.infer<typeof reorderMediaResponseSchema>;

export const deleteMediaResponseSchema = z.object({
  mediaId: z.uuid(),
  status: z.literal('deleting'),
  contentVersion: z.number().int().positive(),
  /** Cover override after the delete (cleared when the deleted item was the cover). */
  coverMediaId: z.uuid().nullable(),
});
export type DeleteMediaResponse = z.infer<typeof deleteMediaResponseSchema>;

/** `DELETE /api/v1/galleries/{id}` acknowledgement (FR-G06); object purge is asynchronous. */
export const deleteGalleryResponseSchema = z.object({
  id: z.uuid(),
  status: z.literal('deleted'),
  deletedAt: z.iso.datetime(),
});
export type DeleteGalleryResponse = z.infer<typeof deleteGalleryResponseSchema>;
