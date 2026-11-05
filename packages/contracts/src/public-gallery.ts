import { GALLERY_LIMITS } from '@lumra/config';
import { z } from 'zod';

/**
 * Recipient-facing gallery payload: `GET /api/v1/public/galleries/{slug}` (PRD §10, FR-V01).
 *
 * Recipients never see internal pipeline states or errors (PRD §4 "Upload UI state"): every
 * internal media status collapses to `ready`, `pending` (still uploading/processing) or
 * `unavailable` (failed or otherwise not deliverable).
 */
export const PUBLIC_MEDIA_STATUSES = ['ready', 'pending', 'unavailable'] as const;
export const publicMediaStatusSchema = z.enum(PUBLIC_MEDIA_STATUSES);
export type PublicMediaStatus = z.infer<typeof publicMediaStatusSchema>;

/**
 * Media URLs are short-lived gateway URLs (FR-V02) — never bucket URLs. Only absolute http(s)
 * URLs or root-relative paths are accepted, so a payload can never smuggle `javascript:` or
 * protocol-relative links into `src`/`href`.
 */
export const mediaUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((url) => /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url), {
    message: 'must be an http(s) URL or a root-relative path',
  });

export const publicMediaVariantSchema = z.object({
  /** Derivative width in px (see `DERIVATIVE_WIDTHS`). */
  width: z.number().int().positive(),
  url: mediaUrlSchema,
});
export type PublicMediaVariant = z.infer<typeof publicMediaVariantSchema>;

const dimensionSchema = z.number().int().positive().nullable();

export const publicMediaItemSchema = z
  .object({
    id: z.uuid(),
    status: publicMediaStatusSchema,
    /** Intrinsic size; `null` while unknown (placeholder tiles use a default aspect ratio). */
    width: dimensionSchema,
    height: dimensionSchema,
    /** Upload order (lower = earlier) for hero selection; display order is the array order. */
    uploadOrder: z.number().int().nonnegative(),
    /** Original filename, used only for alt text (PRD §12). */
    filename: z.string().max(255),
    /** Display derivatives; non-empty for `ready` items, empty otherwise. */
    variants: z.array(publicMediaVariantSchema).max(8),
    /** Original download URL (gateway, `Content-Disposition: attachment`), ready items only. */
    downloadUrl: mediaUrlSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.status === 'ready') {
      if (item.variants.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['variants'], message: 'ready items need variants' });
      }
      if (item.width === null || item.height === null) {
        ctx.addIssue({ code: 'custom', path: ['width'], message: 'ready items need dimensions' });
      }
    } else {
      if (item.variants.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['variants'], message: 'only ready items' });
      }
      if (item.downloadUrl !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['downloadUrl'], message: 'only ready items' });
      }
    }
  });
export type PublicMediaItem = z.infer<typeof publicMediaItemSchema>;

export const publicGallerySchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  title: z.string(),
  coverMediaId: z.uuid().nullable(),
  /** "Made with Lumra" badge (shown for Free-plan galleries). */
  brandingVisible: z.boolean(),
  contentVersion: z.number().int().nonnegative(),
});
export type PublicGallery = z.infer<typeof publicGallerySchema>;

export const publicGalleryResponseSchema = z.object({
  gallery: publicGallerySchema,
  items: z.array(publicMediaItemSchema).max(GALLERY_LIMITS.maxItemsPerGallery),
});
export type PublicGalleryResponse = z.infer<typeof publicGalleryResponseSchema>;
