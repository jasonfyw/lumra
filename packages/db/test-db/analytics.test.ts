import { afterAll, describe, expect, it } from 'vitest';
import {
  actAs,
  connect,
  createGallery,
  createMedia,
  createUser,
  DENIED,
  expectSqlError,
  inRollback,
  type Tx,
} from './helpers';

const sql = connect();
afterAll(() => sql.end());

type EventType = 'view' | 'item_download' | 'archive_download';

async function record(
  tx: Tx,
  gallery: string,
  type: EventType,
  opts: { visitor?: string; bucket?: number; media?: string | null; key?: string | null } = {},
): Promise<boolean> {
  const [row] = await tx<{ counted: boolean }[]>`
    select public.record_gallery_event(
      ${gallery}::uuid, ${type}::public.gallery_event_type, ${opts.media ?? null}::uuid,
      ${opts.visitor ?? 'visitor-a'}, ${opts.bucket ?? 100}::bigint, ${opts.key ?? null}) as counted`;
  return row!.counted;
}

async function stats(tx: Tx, gallery: string) {
  const [row] = await tx<
    {
      view_count: string;
      item_download_count: string;
      archive_download_count: string;
      unique_visitor_count: string;
      last_viewed_at: Date | null;
    }[]
  >`select * from public.gallery_stats where gallery_id = ${gallery}`;
  return row;
}

describe('record_gallery_event', () => {
  it('counts views, dedupes per visitor per 30-minute window and tracks unique visitors', async () => {
    await inRollback(sql, async (tx) => {
      const g = await createGallery(tx, await createUser(tx));
      expect(await record(tx, g, 'view', { bucket: 1 })).toBe(true);
      expect(await record(tx, g, 'view', { bucket: 1 })).toBe(false); // same window
      expect(await record(tx, g, 'view', { bucket: 2 })).toBe(true); // next window, same visitor
      expect(await record(tx, g, 'view', { bucket: 1, visitor: 'visitor-b' })).toBe(true);

      const row = await stats(tx, g);
      expect(Number(row!.view_count)).toBe(3);
      expect(Number(row!.unique_visitor_count)).toBe(2);
      expect(row!.last_viewed_at).toBeInstanceOf(Date);
    });
  });

  it('splits item and archive downloads and never counts a repeated idempotency key twice', async () => {
    await inRollback(sql, async (tx) => {
      const g = await createGallery(tx, await createUser(tx));
      const m = await createMedia(tx, g);
      expect(await record(tx, g, 'item_download', { media: m })).toBe(true);
      expect(await record(tx, g, 'item_download', { media: m })).toBe(true); // distinct actions
      expect(await record(tx, g, 'archive_download', { key: 'k1' })).toBe(true);
      expect(await record(tx, g, 'archive_download', { key: 'k1' })).toBe(false);

      const row = await stats(tx, g);
      expect(Number(row!.item_download_count)).toBe(2);
      expect(Number(row!.archive_download_count)).toBe(1);
      expect(Number(row!.view_count)).toBe(0);
      expect(row!.last_viewed_at).toBeNull();
    });
  });

  it('is atomic under concurrency: parallel identical views count exactly once', async () => {
    const owner = await createUser(sql);
    const g = await createGallery(sql as unknown as Tx, owner);
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => record(sql as unknown as Tx, g, 'view', { bucket: 7 })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await stats(sql as unknown as Tx, g);
      expect(Number(row!.view_count)).toBe(1);
      expect(Number(row!.unique_visitor_count)).toBe(1);
    } finally {
      await sql`delete from public.galleries where id = ${g}`;
      await sql`delete from auth.users where id = ${owner}`;
    }
  });

  it('stats rows are removed with their gallery', async () => {
    await inRollback(sql, async (tx) => {
      const g = await createGallery(tx, await createUser(tx));
      await record(tx, g, 'view');
      await tx`delete from public.galleries where id = ${g}`;
      expect(await tx`select 1 from public.gallery_stats where gallery_id = ${g}`).toHaveLength(0);
    });
  });
});

describe('gallery_stats RLS and privileges', () => {
  it('the owner reads their own stats; another user and anon cannot', async () => {
    await inRollback(sql, async (tx) => {
      const owner = await createUser(tx);
      const other = await createUser(tx);
      const g = await createGallery(tx, owner);
      await record(tx, g, 'view');

      await actAs(tx, 'authenticated', owner);
      const mine = await tx<{ view_count: string }[]>`select view_count from public.gallery_stats`;
      expect(mine.map((r) => Number(r.view_count))).toEqual([1]);

      await actAs(tx, 'authenticated', other);
      expect(await tx`select * from public.gallery_stats`).toHaveLength(0);
      expect(await tx`select * from public.gallery_stats where gallery_id = ${g}`).toHaveLength(0);

      await actAs(tx, 'anon');
      await expectSqlError(tx, DENIED, (sp) => sp`select * from public.gallery_stats`);
    });
  });

  it('a deleted gallery’s stats are hidden from its former owner', async () => {
    await inRollback(sql, async (tx) => {
      const owner = await createUser(tx);
      const g = await createGallery(tx, owner);
      await record(tx, g, 'view');
      await tx`update public.galleries set deleted_at = now(), status = 'deleted' where id = ${g}`;
      await actAs(tx, 'authenticated', owner);
      expect(await tx`select * from public.gallery_stats`).toHaveLength(0);
    });
  });

  it('nobody can write from the client, nor call the recorder', async () => {
    await inRollback(sql, async (tx) => {
      const owner = await createUser(tx);
      const g = await createGallery(tx, owner);
      await record(tx, g, 'view');

      for (const [role, uid] of [
        ['authenticated', owner],
        ['anon', undefined],
      ] as const) {
        await actAs(tx, role, uid);
        await expectSqlError(
          tx,
          DENIED,
          (sp) => sp`update public.gallery_stats set view_count = 1000000`,
        );
        await expectSqlError(
          tx,
          DENIED,
          (sp) => sp`insert into public.gallery_stats (gallery_id) values (${g})`,
        );
        await expectSqlError(tx, DENIED, (sp) => sp`delete from public.gallery_stats`);
        await expectSqlError(tx, DENIED, (sp) => record(sp, g, 'view', { visitor: 'x' }));
      }

      // The event log stays service-only.
      await actAs(tx, 'authenticated', owner);
      await expectSqlError(tx, DENIED, (sp) => sp`select * from public.gallery_events`);

      await actAs(tx, 'service_role');
      expect(await record(tx, g, 'view', { visitor: 'service' })).toBe(true);
    });
  });
});
