import type { GalleryVisibility } from '@lumra/contracts';
import type { TransitionTable } from './state-machine';

/** PRD §7. "expired" is derived from `expiresAt`, so it is not a persisted transition. */
export const GALLERY_TRANSITIONS: TransitionTable<GalleryVisibility> = {
  draft: ['published', 'deleted'],
  published: ['deleted'],
  deleted: [],
};

export type GalleryAccessState = 'draft' | 'published' | 'expired' | 'deleted';

export function galleryAccessState(
  gallery: { status: GalleryVisibility; expiresAt: Date | null },
  now: Date,
): GalleryAccessState {
  if (gallery.status !== 'published') return gallery.status;
  if (gallery.expiresAt && gallery.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'published';
}

/** Furthest a creator may push an expiry (sanity bound; FR-G05 allows `null` = never). */
export const MAX_GALLERY_EXPIRY_MS = 10 * 366 * 24 * 60 * 60 * 1000;

export type ExpiryCheck = { ok: true } | { ok: false; reason: 'in_past' | 'too_far' };

/**
 * FR-G05: expiry is `null` (never) or a UTC instant strictly in the future, at most
 * `MAX_GALLERY_EXPIRY_MS` ahead. An already-expired gallery is revived by moving it forward
 * (J4), so the same rule applies to publish and later edits.
 */
export function checkGalleryExpiry(expiresAt: Date | null, now: Date): ExpiryCheck {
  if (expiresAt === null) return { ok: true };
  const t = expiresAt.getTime();
  if (!Number.isFinite(t) || t <= now.getTime()) return { ok: false, reason: 'in_past' };
  if (t - now.getTime() > MAX_GALLERY_EXPIRY_MS) return { ok: false, reason: 'too_far' };
  return { ok: true };
}

/** Public share path for a slug (FR-G01: stable across title edits). */
export function gallerySharePath(slug: string): string {
  return `/g/${encodeURIComponent(slug)}`;
}
