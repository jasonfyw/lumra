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
