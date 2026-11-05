import { z } from 'zod';

/**
 * Authoritative gallery access state as mirrored to Cloudflare KV (`ACCESS_STATE` binding,
 * key `gallery:{galleryId}`) for the media gateway (ADR-001).
 *
 * The web app (re)writes this document whenever any field changes: publish, password change
 * or revocation (bumps `accessVersion`), expiry change, delivery suspension (spending cap /
 * overdue) and deletion. A missing document means "not servable" — the gateway fails closed.
 */
export const galleryAccessStateSchema = z.object({
  /** Mirrors `galleries.access_version`; tokens carrying a different value are rejected. */
  accessVersion: z.number().int().nonnegative(),
  deleted: z.boolean(),
  /** ISO-8601 instant after which media is no longer served; null = never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** Delivery blocked for billing reasons (PRD §9.4). */
  deliverySuspended: z.boolean(),
  /** When the web app wrote this snapshot (diagnostics only). */
  updatedAt: z.iso.datetime({ offset: true }),
});
export type GalleryAccessState = z.infer<typeof galleryAccessStateSchema>;
