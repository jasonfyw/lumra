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
} from './helpers';

const sql = connect();
afterAll(() => sql.end());

async function ids(query: Promise<{ id: string }[]>): Promise<string[]> {
  return (await query).map((r) => r.id).sort();
}

describe('owner isolation (galleries, media, media_variants)', () => {
  it('user A sees only their own non-deleted galleries, media and variants', async () => {
    await inRollback(sql, async (tx) => {
      const a = await createUser(tx);
      const b = await createUser(tx);
      const gA = await createGallery(tx, a);
      const gADeleted = await createGallery(tx, a, { deleted: true });
      const gB = await createGallery(tx, b);
      const mA = await createMedia(tx, gA);
      const mADeleted = await createMedia(tx, gA, { deleted: true });
      const mB = await createMedia(tx, gB);
      await createMedia(tx, gADeleted);

      await actAs(tx, 'authenticated', a);
      expect(await ids(tx`select id from public.galleries`)).toEqual([gA]);
      expect(await tx`select id from public.galleries where id = ${gB}`).toHaveLength(0);
      expect(await tx`select id from public.galleries where id = ${gADeleted}`).toHaveLength(0);
      expect(await ids(tx`select id from public.media`)).toEqual([mA]);
      expect(await tx`select id from public.media where id in (${mB}, ${mADeleted})`).toHaveLength(
        0,
      );
      const variants = await tx<{ media_id: string }[]>`select media_id from public.media_variants`;
      expect(variants.map((v) => v.media_id)).toEqual([mA]);

      await actAs(tx, 'authenticated', b);
      expect(await ids(tx`select id from public.galleries`)).toEqual([gB]);
      expect(await ids(tx`select id from public.media`)).toEqual([mB]);
    });
  });

  it('browser roles cannot insert, update or delete galleries/media (writes are server-only)', async () => {
    await inRollback(sql, async (tx) => {
      const a = await createUser(tx);
      const b = await createUser(tx);
      const gA = await createGallery(tx, a);
      const gB = await createGallery(tx, b);
      const mB = await createMedia(tx, gB);

      await actAs(tx, 'authenticated', a);
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.galleries set title = 'pwned' where id = ${gB}`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.galleries set status = 'published' where id = ${gA}`,
      );
      await expectSqlError(tx, DENIED, (sp) => sp`delete from public.galleries where id = ${gB}`);
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`insert into public.galleries (owner_id, slug) values (${a}, 'sneakyslug123')`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.media set filename = 'x' where id = ${mB}`,
      );
      await expectSqlError(tx, DENIED, (sp) => sp`delete from public.media where id = ${mB}`);
      await expectSqlError(tx, DENIED, (sp) => sp`delete from public.media_variants`);

      await actAs(tx, 'postgres');
      const [row] = await tx<
        { title: string }[]
      >`select title from public.galleries where id = ${gB}`;
      expect(row!.title).toBe('Untitled gallery');
    });
  });

  it('anon cannot read galleries, media or profiles', async () => {
    await inRollback(sql, async (tx) => {
      await actAs(tx, 'anon');
      for (const table of [
        'galleries',
        'media',
        'media_variants',
        'profiles',
        'billing_accounts',
      ]) {
        await expectSqlError(tx, DENIED, (sp) => sp`select * from ${sp('public.' + table)}`);
      }
    });
  });
});

describe('profiles and billing_accounts', () => {
  it('handle_new_user provisions a profile on the current Free plan and a Free billing account', async () => {
    await inRollback(sql, async (tx) => {
      const u = await createUser(tx, 'new-user@example.test');
      const [p] = await tx<{ email: string; plan_id: string }[]>`
        select email, plan_id from public.profiles where user_id = ${u}`;
      expect(p).toEqual({ email: 'new-user@example.test', plan_id: 'free' });
      const [b] = await tx<{ status: string }[]>`
        select status from public.billing_accounts where user_id = ${u}`;
      expect(b!.status).toBe('free');
    });
  });

  it('a user reads only their own profile/billing and may change only display_name', async () => {
    await inRollback(sql, async (tx) => {
      const a = await createUser(tx);
      const b = await createUser(tx);
      await actAs(tx, 'authenticated', a);

      const profiles = await tx<{ user_id: string }[]>`select user_id from public.profiles`;
      expect(profiles.map((p) => p.user_id)).toEqual([a]);
      const accounts = await tx<{ user_id: string }[]>`select user_id from public.billing_accounts`;
      expect(accounts.map((p) => p.user_id)).toEqual([a]);

      const own = await tx`update public.profiles set display_name = 'Ada' where user_id = ${a}`;
      expect(own.count).toBe(1);
      const other =
        await tx`update public.profiles set display_name = 'Mallory' where user_id = ${b}`;
      expect(other.count).toBe(0);

      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.profiles set email = 'x@example.test' where user_id = ${a}`,
      );
      await expectSqlError(tx, DENIED, (sp) => sp`update public.profiles set plan_id = 'pro'`);
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.billing_accounts set status = 'active'`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.billing_accounts set spend_cap_micro_usd = 0`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`delete from public.profiles where user_id = ${a}`,
      );

      await actAs(tx, 'postgres');
      const [bp] = await tx<{ display_name: string | null }[]>`
        select display_name from public.profiles where user_id = ${b}`;
      expect(bp!.display_name).toBeNull();
    });
  });
});

describe('plans', () => {
  it('are publicly readable but not writable', async () => {
    await inRollback(sql, async (tx) => {
      for (const role of ['anon', 'authenticated'] as const) {
        await actAs(tx, role);
        const rows = await tx<{ id: string }[]>`select id from public.plans order by id`;
        expect(rows.map((r) => r.id)).toEqual(['free', 'pro']);
        await expectSqlError(
          tx,
          DENIED,
          (sp) => sp`update public.plans set monthly_fee_micro_usd = 0`,
        );
        await expectSqlError(tx, DENIED, (sp) => sp`delete from public.plans`);
      }
    });
  });
});

const SERVICE_ONLY_TABLES = [
  'guest_sessions',
  'upload_sessions',
  'archive_jobs',
  'archive_parts',
  'gallery_access_sessions',
  'gallery_events',
  'usage_ledger',
  'billing_exports',
  'job_outbox',
  'provider_webhook_events',
  'rate_limit_buckets',
  'storage_accrual_cursors',
] as const;

describe('service-only tables', () => {
  for (const table of SERVICE_ONLY_TABLES) {
    it(`${table}: anon and authenticated cannot select, insert, update or delete`, async () => {
      await inRollback(sql, async (tx) => {
        const user = await createUser(tx);
        for (const [role, uid] of [
          ['anon', undefined],
          ['authenticated', user],
        ] as const) {
          await actAs(tx, role, uid);
          const t = tx('public.' + table);
          await expectSqlError(tx, DENIED, (sp) => sp`select * from ${t}`);
          await expectSqlError(tx, DENIED, (sp) => sp`insert into ${t} default values`);
          await expectSqlError(tx, DENIED, (sp) => sp`update ${t} set created_at = now()`);
          await expectSqlError(tx, DENIED, (sp) => sp`delete from ${t}`);
        }
        // service_role (trusted server/worker) retains access.
        await actAs(tx, 'service_role');
        await tx`select count(*) from ${tx('public.' + table)}`;
      });
    });
  }

  it('have no RLS policies and no browser-role privileges in the catalog', async () => {
    const policies = await sql<{ tablename: string }[]>`
      select tablename from pg_policies
      where schemaname = 'public' and tablename in ${sql(SERVICE_ONLY_TABLES)}`;
    expect(policies).toEqual([]);

    const grants = await sql<{ table_name: string; grantee: string }[]>`
      select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name in ${sql(SERVICE_ONLY_TABLES)}
        and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(grants).toEqual([]);
  });

  it('every public table has RLS enabled', async () => {
    const rows = await sql<{ relname: string }[]>`
      select relname from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`;
    expect(rows).toEqual([]);
  });
});
