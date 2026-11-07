import { GALLERY_LIMITS, PUBLIC_GALLERY } from '@lumra/config';
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
    /**
     * Display derivatives (short-lived gateway URLs). Empty for non-ready items, and also for
     * ready items whose URLs were not minted in this payload: the client mints those on demand
     * through `media-tokens` when the tile becomes visible (ADR-001 token minting strategy).
     */
    variants: z.array(publicMediaVariantSchema).max(8),
    /** Original download URL (gateway, `Content-Disposition: attachment`), ready items only. */
    downloadUrl: mediaUrlSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.status === 'ready') {
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
  /** Earliest expiry of the URLs minted into this payload (absent when none were minted). */
  urlsExpireAt: z.iso.datetime({ offset: true }).optional(),
});
export type PublicGalleryResponse = z.infer<typeof publicGalleryResponseSchema>;

/**
 * What `GET /api/v1/public/galleries/{slug}` returns for a password-protected gallery without a
 * valid gallery session: nothing about the gallery beyond the fact that it is locked (FR-V01).
 */
export const publicGalleryLockedSchema = z.object({ passwordRequired: z.literal(true) });
export type PublicGalleryLocked = z.infer<typeof publicGalleryLockedSchema>;

export const publicGalleryLookupSchema = z.union([
  publicGalleryLockedSchema,
  publicGalleryResponseSchema,
]);
export type PublicGalleryLookup = z.infer<typeof publicGalleryLookupSchema>;

/** `POST /api/v1/public/galleries/{slug}/unlock` (FR-G04, T19). */
export const unlockGalleryRequestSchema = z.object({
  password: z.string().min(1).max(PUBLIC_GALLERY.maxPasswordLength),
});
export type UnlockGalleryRequest = z.infer<typeof unlockGalleryRequestSchema>;

export const unlockGalleryResponseSchema = z.object({
  unlocked: z.literal(true),
  /** Session expiry; null when the gallery has no password (no session needed). */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type UnlockGalleryResponse = z.infer<typeof unlockGalleryResponseSchema>;

/** `POST /api/v1/public/galleries/{slug}/media-tokens` (PRD §6.2, T20). */
export const PUBLIC_MEDIA_TOKEN_ACTIONS = ['preview', 'original'] as const;
export const mediaTokensRequestSchema = z.object({
  mediaIds: z
    .array(z.uuid())
    .min(1)
    .max(PUBLIC_GALLERY.maxMediaTokenIds)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'mediaIds must be unique' }),
  action: z.enum(PUBLIC_MEDIA_TOKEN_ACTIONS),
});
export type MediaTokensRequest = z.infer<typeof mediaTokensRequestSchema>;

export const mintedMediaUrlsSchema = z.object({
  id: z.uuid(),
  /** `preview`: every available display derivative. Empty for `original`. */
  variants: z.array(publicMediaVariantSchema).max(8),
  /** `original`: gateway download URL (`Content-Disposition: attachment`). */
  downloadUrl: mediaUrlSchema.optional(),
});
export type MintedMediaUrls = z.infer<typeof mintedMediaUrlsSchema>;

export const mediaTokensResponseSchema = z.object({
  /** When every URL in `items` stops working. */
  expiresAt: z.iso.datetime({ offset: true }),
  items: z.array(mintedMediaUrlsSchema).max(PUBLIC_GALLERY.maxMediaTokenIds),
  /** Requested ids that were not minted: not in this gallery, not ready, or removed. */
  missing: z.array(z.uuid()).max(PUBLIC_GALLERY.maxMediaTokenIds),
});
export type MediaTokensResponse = z.infer<typeof mediaTokensResponseSchema>;
