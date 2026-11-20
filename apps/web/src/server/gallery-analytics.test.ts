import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumra/db';
import type { Logger } from '@lumra/observability';

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void fn() }));

const { getGalleryAnalytics, trackGalleryEvent, visitorFromHeaders } =
  await import('./gallery-analytics');

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const GALLERY = '11111111-1111-4111-8111-111111111111';
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

/** A fake database: the first query resolves the gallery, the rest are `record_gallery_event`. */
function fakeDb(
  gallery: { id: string; owner_id: string | null } | null = { id: GALLERY, owner_id: OWNER },
) {
  const execute = vi.fn(async (query: unknown) => {
    const isLookup = JSON.stringify(query).includes('owner_id');
    return isLookup ? (gallery ? [gallery] : []) : [{ record_gallery_event: true }];
  });
  return { db: { execute } as unknown as Database, execute };
}

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function track(
  db: Database,
  event: Parameters<typeof trackGalleryEvent>[2],
  opts: { ua?: string | null; user?: { userId: string } | null; schedule?: boolean } = {},
) {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.9' });
  if (opts.ua !== null) headers.set('user-agent', opts.ua ?? CHROME);
  const pending: Promise<void>[] = [];
  trackGalleryEvent(
    db,
    'slug',
    event,
    visitorFromHeaders(headers, Promise.resolve(opts.user ?? null)),
    {
      log,
      pepper: () => 'test-pepper',
      schedule: (work) => void pending.push(work()),
    },
  );
  return Promise.all(pending);
}

beforeEach(() => vi.clearAllMocks());

describe('trackGalleryEvent', () => {
  it('counts a human view', async () => {
    const { db, execute } = fakeDb();
    await track(db, { type: 'view' });
    expect(execute).toHaveBeenCalledTimes(2); // gallery lookup + record_gallery_event
  });

  it('does not even schedule work for bots or a missing user agent', async () => {
    const { db, execute } = fakeDb();
    await track(db, { type: 'view' }, { ua: 'Googlebot/2.1' });
    await track(db, { type: 'view' }, { ua: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not count the gallery owner viewing or downloading their own gallery', async () => {
    const { db, execute } = fakeDb();
    await track(db, { type: 'view' }, { user: { userId: OWNER } });
    await track(db, { type: 'archive_download' }, { user: { userId: OWNER } });
    expect(execute).toHaveBeenCalledTimes(2); // lookups only, no record calls
  });

  it('counts another signed-in user', async () => {
    const { db, execute } = fakeDb();
    await track(db, { type: 'view' }, { user: { userId: OTHER } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('records one event per downloaded item', async () => {
    const { db, execute } = fakeDb();
    await track(db, { type: 'item_download', mediaIds: [OTHER, OWNER, GALLERY] });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('ignores unknown galleries', async () => {
    const { db, execute } = fakeDb(null);
    await track(db, { type: 'view' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('swallows database failures with a structured warning that carries no identifiers', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('connection to 10.0.0.1 failed')) };
    await expect(track(db as unknown as Database, { type: 'view' })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith('gallery analytics skipped', {
      event: 'view',
      error: 'Error',
    });
  });

  it('never throws when scheduling itself fails', () => {
    const { db } = fakeDb();
    expect(() =>
      trackGalleryEvent(
        db,
        'slug',
        { type: 'view' },
        visitorFromHeaders(new Headers({ 'user-agent': CHROME }), Promise.resolve(null)),
        {
          log,
          schedule: () => {
            throw new Error('outside request scope');
          },
        },
      ),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('visitorFromHeaders', () => {
  it('keeps only a truncated network prefix, never the raw IP', () => {
    const v = visitorFromHeaders(
      new Headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': CHROME }),
      Promise.resolve(null),
    );
    expect(v.signal).toBe(`v4:203.0.113.9|${CHROME}`);
  });
});

describe('getGalleryAnalytics', () => {
  const row = (owner: string | null, extra: Record<string, unknown> = {}) => ({
    db: {
      execute: vi.fn(async () => [
        {
          owner_id: owner,
          view_count: null,
          unique_visitor_count: null,
          item_download_count: null,
          archive_download_count: null,
          last_viewed_at: null,
          ...extra,
        },
      ]),
    } as unknown as Database,
  });

  it('returns zeros for a gallery without a stats row', async () => {
    expect(await getGalleryAnalytics(row(OWNER).db, OWNER, GALLERY)).toEqual({
      views: 0,
      uniqueVisitors: 0,
      itemDownloads: 0,
      archiveDownloads: 0,
      downloads: 0,
      lastViewedAt: null,
    });
  });

  it('maps bigint counters and sums downloads', async () => {
    const { db } = row(OWNER, {
      view_count: '142',
      unique_visitor_count: '12',
      item_download_count: '20',
      archive_download_count: '3',
      last_viewed_at: new Date('2026-11-20T10:00:00Z'),
    });
    expect(await getGalleryAnalytics(db, OWNER, GALLERY)).toEqual({
      views: 142,
      uniqueVisitors: 12,
      itemDownloads: 20,
      archiveDownloads: 3,
      downloads: 23,
      lastViewedAt: '2026-11-20T10:00:00.000Z',
    });
  });

  it('conceals other users’ and missing galleries as not_found', async () => {
    await expect(getGalleryAnalytics(row(OWNER).db, OTHER, GALLERY)).rejects.toMatchObject({
      error: { code: 'not_found' },
    });
    const empty = { execute: vi.fn(async () => []) } as unknown as Database;
    await expect(getGalleryAnalytics(empty, OWNER, GALLERY)).rejects.toMatchObject({
      error: { code: 'not_found' },
    });
    await expect(getGalleryAnalytics(empty, OWNER, 'not-a-uuid')).rejects.toMatchObject({
      error: { code: 'not_found' },
    });
  });
});
