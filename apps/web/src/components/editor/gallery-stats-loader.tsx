import 'server-only';
import type { GalleryAnalytics } from '@lumra/contracts';
import { getDb } from '@/lib/db';
import { logger } from '@/lib/log';
import { getGalleryAnalytics } from '@/server/gallery-analytics';
import { GalleryStatsLine } from './gallery-stats';

/**
 * Server component for the owner's gallery page: loads the counters on its own (inside a
 * Suspense boundary at the call site), so a slow or failing read never blocks or breaks the
 * editor. Ownership is re-checked by `getGalleryAnalytics`.
 */
export async function GalleryStats({ userId, galleryId }: { userId: string; galleryId: string }) {
  let stats: GalleryAnalytics | null = null;
  try {
    stats = await getGalleryAnalytics(getDb(), userId, galleryId);
  } catch (error) {
    logger.warn('gallery stats unavailable', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  return <GalleryStatsLine stats={stats} now={new Date()} />;
}
