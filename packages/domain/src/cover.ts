import type { MediaStatus, PublicMediaStatus } from '@lumra/contracts';

/**
 * Hero/cover selection (PRD §4 "Hero", T15/T17). The cover is data (`galleries.cover_media_id`),
 * not a separate object: a creator override wins when that item is present and ready;
 * otherwise the first ready item by upload order; otherwise `null` → neutral placeholder.
 */
export interface CoverCandidate {
  id: string;
  /** Internal status (creator views) or the recipient-facing status (public gallery). */
  status: MediaStatus | PublicMediaStatus;
  /** Upload order (e.g. reservation sequence or `created_at` epoch ms); lower = earlier. */
  uploadOrder: number;
}

export function selectCover<T extends CoverCandidate>(
  items: readonly T[],
  overrideId: string | null | undefined,
): T | null {
  if (overrideId) {
    const override = items.find((item) => item.id === overrideId);
    if (override && override.status === 'ready') return override;
  }
  let best: T | null = null;
  for (const item of items) {
    if (item.status !== 'ready') continue;
    if (
      best === null ||
      item.uploadOrder < best.uploadOrder ||
      // Deterministic tie-break so SSR and client agree.
      (item.uploadOrder === best.uploadOrder && item.id < best.id)
    ) {
      best = item;
    }
  }
  return best;
}
