import { randomUUID } from 'node:crypto';
import { RATE_CARD_V1, type PlanId } from '@lumra/config';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  connect,
  createGallery,
  createMedia,
  createUser,
  expectSqlError,
  inRollback,
  slug,
  UNIQUE_VIOLATION,
  type Tx,
} from './helpers';

const sql = connect();
afterAll(() => sql.end());

async function guestSession(tx: Tx): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.guest_sessions (capability_hash, expires_at)
    values (${randomUUID()}, now() + interval '24 hours') returning id`;
  return row!.id;
}

describe('gallery ownership CHECK', () => {
  it('accepts owner-only, guest-only and claimed rows', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const guest = await guestSession(tx);
      await tx`insert into public.galleries (owner_id, slug) values (${user}, ${slug()})`;
      await tx`insert into public.galleries (guest_session_id, slug) values (${guest}, ${slug()})`;
      await tx`
        insert into public.galleries (owner_id, guest_session_id, claimed_at, slug)
        values (${user}, ${guest}, now(), ${slug()})`;
    });
  });

  it('rejects rows with no owner, two owners before claim, or claimed without an owner', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const guest = await guestSession(tx);
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`insert into public.galleries (slug) values (${slug()})`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`insert into public.galleries (owner_id, guest_session_id, slug) values (${user}, ${guest}, ${slug()})`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`insert into public.galleries (guest_session_id, claimed_at, slug) values (${guest}, now(), ${slug()})`,
      );
    });
  });

  it('requires an owner to publish and keeps status/deleted_at consistent', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const guest = await guestSession(tx);
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`insert into public.galleries (guest_session_id, slug, status, published_at)
                   values (${guest}, ${slug()}, 'published', now())`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`insert into public.galleries (owner_id, slug, status) values (${user}, ${slug()}, 'published')`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`insert into public.galleries (owner_id, slug, status) values (${user}, ${slug()}, 'deleted')`,
      );
      await tx`insert into public.galleries (owner_id, slug, status, published_at)
               values (${user}, ${slug()}, 'published', now())`;
    });
  });

  it('enforces unique slugs and valid slug format', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const s = slug();
      await tx`insert into public.galleries (owner_id, slug) values (${user}, ${s})`;
      await expectSqlError(
        tx,
        UNIQUE_VIOLATION,
        (sp) => sp`insert into public.galleries (owner_id, slug) values (${user}, ${s})`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`insert into public.galleries (owner_id, slug) values (${user}, 'a/../b')`,
      );
    });
  });
});

describe('uniqueness and integrity constraints', () => {
  it('media_variants (media_id, variant) and media size bounds', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const gallery = await createGallery(tx, user);
      const mediaId = await createMedia(tx, gallery); // creates variant w320
      await expectSqlError(
        tx,
        UNIQUE_VIOLATION,
        (
          sp,
        ) => sp`insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
                   values (${mediaId}, 'w320', ${randomUUID()}, 'image/webp', 320, 240, 1)`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (
          sp,
        ) => sp`insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key)
                   values (${gallery}, ${randomUUID()}, 'big.jpg', 'image/jpeg', 50000001, 'a0')`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (
          sp,
        ) => sp`insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key)
                   values (${gallery}, ${randomUUID()}, 'clip.mp4', 'video/mp4', 10, 'a0')`,
      );
    });
  });

  it('media.sort_key orders by byte value (COLLATE "C") for base-62 fractional keys', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const gallery = await createGallery(tx, user);
      for (const key of ['a', 'B', 'Z', '0', 'b', 'a0']) {
        await tx`insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key)
                 values (${gallery}, ${randomUUID()}, 'p.jpg', 'image/jpeg', 1, ${key})`;
      }
      const rows = await tx<{ sort_key: string }[]>`
        select sort_key from public.media where gallery_id = ${gallery} order by sort_key`;
      expect(rows.map((r) => r.sort_key)).toEqual(['0', 'B', 'Z', 'a', 'a0', 'b']);
    });
  });

  it('usage_ledger is unique on (metric, source_id), unit-checked and append-only', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const insert = (sp: Tx, metric: string, unit: string, sourceId: string) => sp`
        insert into public.usage_ledger (account_id, metric, quantity_micro_units, unit, source_id, event_time, period_start, rating_version)
        values (${user}, ${metric}, 1000, ${unit}, ${sourceId}, now(), date_trunc('month', now()), 1)`;
      await insert(tx, 'delivery_bytes', 'bytes', 'evt-1');
      await insert(tx, 'storage_byte_seconds', 'byte_seconds', 'evt-1');
      await expectSqlError(tx, UNIQUE_VIOLATION, (sp) =>
        insert(sp, 'delivery_bytes', 'bytes', 'evt-1'),
      );
      await expectSqlError(tx, CHECK_VIOLATION, (sp) =>
        insert(sp, 'delivery_bytes', 'byte_seconds', 'evt-2'),
      );
      await expectSqlError(
        tx,
        '23001',
        (sp) => sp`update public.usage_ledger set quantity_micro_units = 0`,
      );
      await expectSqlError(tx, '23001', (sp) => sp`delete from public.usage_ledger`);
    });
  });

  it('provider_webhook_events is unique on (provider, provider_event_id)', async () => {
    await inRollback(sql, async (tx) => {
      await tx`insert into public.provider_webhook_events (provider, provider_event_id) values ('stripe', 'evt_1')`;
      await expectSqlError(
        tx,
        UNIQUE_VIOLATION,
        (sp) =>
          sp`insert into public.provider_webhook_events (provider, provider_event_id) values ('stripe', 'evt_1')`,
      );
    });
  });

  it('gallery_events dedupes views per anonymous session per 30-minute window', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const gallery = await createGallery(tx, user);
      const view = (sp: Tx, bucket: number) => sp`
        insert into public.gallery_events (gallery_id, event_type, anonymous_session_hash, window_bucket)
        values (${gallery}, 'view', 'anon-hash', ${bucket})`;
      await view(tx, 1);
      await view(tx, 2);
      await expectSqlError(tx, UNIQUE_VIOLATION, (sp) => view(sp, 1));
    });
  });

  it('updated_at is maintained by trigger', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const gallery = await createGallery(tx, user);
      await tx`update public.galleries set updated_at = '2000-01-01' where id = ${gallery}`;
      const [row] = await tx<{ fresh: boolean }[]>`
        select updated_at > '2001-01-01' as fresh from public.galleries where id = ${gallery}`;
      expect(row!.fresh).toBe(true);
    });
  });
});

describe('plans seed', () => {
  it('matches RATE_CARD_V1 from @lumra/config', async () => {
    const rows = await sql`select * from public.plans order by id`;
    expect(rows.map((r) => r.id)).toEqual(['free', 'pro']);
    const num = (v: unknown) => (v === null ? null : Number(v));
    for (const row of rows) {
      const rc = RATE_CARD_V1[row.id as PlanId];
      expect({
        id: row.id,
        rateVersion: row.rate_version,
        monthlyFeeMicroUsd: num(row.monthly_fee_micro_usd),
        maxActiveGalleries: row.max_active_galleries,
        maxStorageBytes: num(row.max_storage_bytes),
        maxDeliveryBytesPerMonth: num(row.max_delivery_bytes_per_month),
        includedStorageGbMonth: row.included_storage_gb_month,
        includedDeliveryGb: row.included_delivery_gb,
        storageOverageMicroUsdPerGbMonth: num(row.storage_overage_micro_usd_per_gb_month),
        deliveryOverageMicroUsdPerGb: num(row.delivery_overage_micro_usd_per_gb),
        defaultOverageCapMicroUsd: num(row.default_overage_cap_micro_usd),
        brandingVisible: row.branding_visible,
      }).toEqual(rc);
    }
  });
});
