import 'server-only';
import { sql } from 'drizzle-orm';
import { after } from 'next/server';
import type { GalleryAnalytics } from '@lumra/contracts';
import type { Database } from '@lumra/db';
import { anonymousVisitorHash, isBotUserAgent, viewWindowBucket } from '@lumra/domain';
import type { Logger } from '@lumra/observability';
import { notFoundError } from '@/lib/api';
import { logger } from '@/lib/log';
import { clientIp, rateLimitPepper } from '@/lib/rate-limit';
import { truncateIp } from '@/lib/rate-limit-key';

/**
 * Gallery analytics (FR-N02, T26). Counting is best-effort and must never affect a recipient:
 * every entry point only *schedules* work, and failures are logged (no IPs, tokens or filenames)
 * and swallowed. The counting rules (bot filter, window, visitor hash) live in `@lumra/domain`;
 * `public.record_gallery_event` applies dedupe and bumps the counters atomically.
 */

export type AnalyticsEvent =
  | { type: 'view' }
  | { type: 'item_download'; mediaIds: readonly string[] }
  | { type: 'archive_download' };

/** What the request exposes, captured while the request scope is still alive. */
export interface Visitor {
  userAgent: string | null;
  /** Truncated network prefix (never the raw IP) plus the UA; input to the daily visitor hash. */
  signal: string;
  /** Verified signed-in viewer, if any. The owner previewing their own gallery isn't counted. */
  user: Promise<{ userId: string } | null>;
}

export function visitorFromHeaders(
  headers: Headers,
  user: Promise<{ userId: string } | null>,
): Visitor {
  const userAgent = headers.get('user-agent');
  return {
    userAgent,
    signal: `${truncateIp(clientIp(headers))}|${userAgent ?? ''}`,
    // A failed lookup must never surface (and never be an unhandled rejection).
    user: user.catch(() => null),
  };
}

export interface TrackOptions {
  log?: Logger;
  now?: Date;
  /** Defaults to `after()` so the work runs once the response is sent. Injected in tests. */
  schedule?: (work: () => Promise<void>) => void;
  /** Defaults to the shared rate-limit/guest pepper (domain-separated by the hash prefix). */
  pepper?: () => string;
}

interface GalleryRef extends Record<string, unknown> {
  id: string;
  owner_id: string | null;
}

/**
 * Counts `event` for the gallery behind `slug`, skipping bots and the owner. Returns
 * immediately; the database work happens after the response.
 */
export function trackGalleryEvent(
  db: Database,
  slug: string,
  event: AnalyticsEvent,
  visitor: Visitor,
  options: TrackOptions = {},
): void {
  const log = options.log ?? logger;
  // Cheap, synchronous gate first: bots never cost a query.
  if (isBotUserAgent(visitor.userAgent)) return;
  const run = async () => {
    try {
      await countEvent(db, slug, event, visitor, options);
    } catch (error) {
      log.warn('gallery analytics skipped', {
        event: event.type,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  };
  try {
    (options.schedule ?? defaultSchedule)(run);
  } catch (error) {
    log.warn('gallery analytics not scheduled', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

function defaultSchedule(work: () => Promise<void>): void {
  after(work);
}

async function countEvent(
  db: Database,
  slug: string,
  event: AnalyticsEvent,
  visitor: Visitor,
  options: TrackOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  const [gallery] = await db.execute<GalleryRef>(
    sql`select id, owner_id from public.galleries where slug = ${slug} and deleted_at is null limit 1`,
  );
  if (!gallery) return;
  const viewer = await visitor.user.catch(() => null);
  if (viewer && viewer.userId === gallery.owner_id) return;

  const hash = await anonymousVisitorHash(
    (options.pepper ?? rateLimitPepper)(),
    gallery.id,
    visitor.signal,
    now,
  );
  const bucket = viewWindowBucket(now);
  const record = (type: string, mediaId: string | null) =>
    db.execute(sql`
      select public.record_gallery_event(
        ${gallery.id}::uuid, ${type}::public.gallery_event_type, ${mediaId}::uuid,
        ${hash}, ${bucket}::bigint, null)`);

  switch (event.type) {
    case 'view':
      await record('view', null);
      break;
    case 'archive_download':
      await record('archive_download', null);
      break;
    case 'item_download':
      for (const mediaId of event.mediaIds) await record('item_download', mediaId);
      break;
  }
}

interface StatsRow extends Record<string, unknown> {
  owner_id: string | null;
  view_count: string | number | null;
  unique_visitor_count: string | number | null;
  item_download_count: string | number | null;
  archive_download_count: string | number | null;
  last_viewed_at: Date | string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner-only counters for `GET /api/v1/galleries/{id}/analytics`. Another user's, unknown or
 * deleted gallery is the same concealed 404 as the rest of the editor API. A gallery nobody has
 * viewed yet has no stats row: zeros.
 */
export async function getGalleryAnalytics(
  db: Database,
  userId: string,
  galleryId: string,
): Promise<GalleryAnalytics> {
  if (!UUID.test(galleryId)) throw notFoundError();
  const [row] = await db.execute<StatsRow>(sql`
    select g.owner_id, s.view_count, s.unique_visitor_count, s.item_download_count,
           s.archive_download_count, s.last_viewed_at
    from public.galleries g
    left join public.gallery_stats s on s.gallery_id = g.id
    where g.id = ${galleryId}::uuid and g.deleted_at is null`);
  if (!row || row.owner_id !== userId) throw notFoundError();
  const item = Number(row.item_download_count ?? 0);
  const archive = Number(row.archive_download_count ?? 0);
  return {
    views: Number(row.view_count ?? 0),
    uniqueVisitors: Number(row.unique_visitor_count ?? 0),
    itemDownloads: item,
    archiveDownloads: archive,
    downloads: item + archive,
    lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at).toISOString() : null,
  };
}
