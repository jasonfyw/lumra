/**
 * T27 integration tests: versioned rate card, usage-ledger adapters and metering writes against
 * the local Supabase stack. Everything runs in rolled-back transactions.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_CARD_V1 } from '@lumra/config';
import { buildLedgerEntry, planStorageAccrual, rateDeliveryEvents } from '@lumra/billing';
import { createBillingRepository } from '../src';
import {
  CHECK_VIOLATION,
  DENIED,
  actAs,
  connect,
  createGallery,
  createUser,
  expectSqlError,
  inRollback,
  type Sql,
  type Tx,
} from './helpers';

const RESTRICT = '23001';
const FK_VIOLATION = '23503';

let sql: Sql;
beforeAll(() => {
  sql = connect();
});
afterAll(async () => {
  await sql.end();
});

const repoFor = (tx: Tx) => createBillingRepository(tx as unknown as postgres.Sql);
const nov = new Date('2026-11-01T00:00:00Z');
const dec = new Date('2026-12-01T00:00:00Z');

describe('plan_rate_versions', () => {
  it('is seeded with the PRD §9.2 proposed rate card and readable by everyone', async () => {
    await inRollback(sql, async (tx) => {
      const repo = repoFor(tx);
      expect(await repo.plans.getRates('free', 1)).toEqual(RATE_CARD_V1.free);
      expect(await repo.plans.getRates('pro', 1)).toEqual(RATE_CARD_V1.pro);
      expect(await repo.plans.getCurrent('pro')).toEqual(RATE_CARD_V1.pro);
      await expect(repo.plans.getRates('pro', 99)).rejects.toThrow(/No rate card/);

      for (const role of ['anon', 'authenticated'] as const) {
        await actAs(tx, role);
        const rows = await tx<{ plan_id: string; decision: string }[]>`
          select plan_id, decision from public.plan_rate_versions order by plan_id`;
        expect(rows).toEqual([
          { plan_id: 'free', decision: 'proposed' },
          { plan_id: 'pro', decision: 'proposed' },
        ]);
        await expectSqlError(
          tx,
          DENIED,
          (sp) => sp`update public.plan_rate_versions set decision = 'confirmed'`,
        );
        await expectSqlError(tx, DENIED, (sp) => sp`delete from public.plan_rate_versions`);
      }
    });
  });

  it('keeps rates immutable; only proposed → confirmed is allowed', async () => {
    await inRollback(sql, async (tx) => {
      await expectSqlError(
        tx,
        RESTRICT,
        (sp) => sp`update public.plan_rate_versions set delivery_overage_micro_usd_per_gb = 1
                   where plan_id = 'pro'`,
      );
      await expectSqlError(tx, RESTRICT, (sp) => sp`delete from public.plan_rate_versions`);
      await tx`update public.plan_rate_versions set decision = 'confirmed' where plan_id = 'pro'`;
      await expectSqlError(
        tx,
        RESTRICT,
        (sp) =>
          sp`update public.plan_rate_versions set decision = 'proposed' where plan_id = 'pro'`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.plan_rate_versions set decision = 'maybe' where plan_id = 'free'`,
      );
    });
  });

  it('projects the current version onto plans when the pointer moves', async () => {
    await inRollback(sql, async (tx) => {
      await tx`
        insert into public.plan_rate_versions (
          plan_id, rate_version, monthly_fee_micro_usd, included_storage_gb_month,
          included_delivery_gb, storage_overage_micro_usd_per_gb_month,
          delivery_overage_micro_usd_per_gb, default_overage_cap_micro_usd, branding_visible
        ) values ('pro', 2, 2000000, 3, 10, 80000, 20000, 15000000, false)`;
      // Direct writes to the projected columns are overwritten from the version row.
      await tx`update public.plans set rate_version = 2, monthly_fee_micro_usd = 1 where id = 'pro'`;
      const repo = repoFor(tx);
      const current = await repo.plans.getCurrent('pro');
      expect(current).toMatchObject({ rateVersion: 2, includedDeliveryGb: 10 });
      const [plan] = await tx<{ monthly_fee_micro_usd: string; included_delivery_gb: number }[]>`
        select monthly_fee_micro_usd::text, included_delivery_gb from public.plans where id = 'pro'`;
      expect(plan).toEqual({ monthly_fee_micro_usd: '2000000', included_delivery_gb: 10 });
      // v1 stays available for rating periods recorded under it.
      expect(await repo.plans.getRates('pro', 1)).toEqual(RATE_CARD_V1.pro);
      await expectSqlError(
        tx,
        FK_VIOLATION,
        (sp) => sp`update public.plans set rate_version = 99 where id = 'pro'`,
      );
    });
  });
});

describe('usage ledger adapter', () => {
  it('appends idempotently, maps units, and reads totals/list back exactly', async () => {
    await inRollback(sql, async (tx) => {
      const accountId = await createUser(tx);
      const repo = repoFor(tx);
      const huge = 2n ** 60n; // beyond 2^53: byte-seconds must survive as bigint
      const storage = buildLedgerEntry({
        accountId,
        metric: 'storage_byte_seconds',
        unit: 'byte_second',
        quantity: huge,
        sourceId: `${accountId}:w1`,
        eventTime: new Date('2026-11-09T00:00:00Z'),
        period: { start: nov, end: dec },
        rateVersion: 1,
      });
      const delivery = buildLedgerEntry({
        accountId,
        metric: 'delivery_bytes',
        unit: 'byte',
        quantity: 1234,
        sourceId: `jti-${randomUUID()}:0-1233`,
        eventTime: new Date('2026-11-09T01:00:00Z'),
        period: { start: nov, end: dec },
        rateVersion: 1,
        estimatedCostMicroUsd: 7,
      });
      expect(await repo.ledger.appendIfAbsent(storage)).toBe(true);
      expect(await repo.ledger.appendIfAbsent(storage)).toBe(false);
      expect(await repo.ledger.appendMany([delivery, delivery, storage])).toBe(1);

      expect(await repo.ledger.totals(accountId, nov)).toEqual({
        storage_byte_seconds: huge,
        delivery_bytes: 1234n,
      });
      expect(await repo.ledger.list(accountId, nov, dec)).toEqual([storage, delivery]);
      const [unitRow] = await tx<{ unit: string }[]>`
        select unit from public.usage_ledger where source_id = ${storage.sourceId}`;
      expect(unitRow!.unit).toBe('byte_seconds');
    });
  });
});

describe('billing account + reservations adapters', () => {
  it('reads the account with its current plan, and pending upload reservations', async () => {
    await inRollback(sql, async (tx) => {
      const accountId = await createUser(tx);
      const repo = repoFor(tx);
      expect(await repo.accounts.get(accountId)).toMatchObject({
        accountId,
        status: 'free',
        planId: 'free',
        rateVersion: 1,
        warningThresholdsPct: [50, 80, 100],
        billingPeriodStart: null,
      });
      expect(await repo.accounts.get(randomUUID())).toBeNull();

      const galleryId = await createGallery(tx, accountId);
      const mediaId = randomUUID();
      await tx`
        insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status)
        values (${mediaId}, ${galleryId}, ${`originals/t/${galleryId}/${mediaId}/source`}, 'a.jpg',
                'image/jpeg', 1000000, 'a0', 'uploading')`;
      const [us] = await tx<{ id: string }[]>`
        insert into public.upload_sessions (gallery_id, media_id, part_size, reserved_bytes, expires_at, idempotency_key)
        values (${galleryId}, ${mediaId}, 5242880, 1000000, now() + interval '1 hour', ${randomUUID()})
        returning id`;
      await tx`update public.media set upload_session_id = ${us!.id} where id = ${mediaId}`;
      const pending = await repo.reservations.pending(accountId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe('upload');
      expect(pending[0]!.bytes).toBeGreaterThan(1_000_000); // original + derivative estimate
    });
  });
});

describe('metering repository', () => {
  it('resolves gallery owners and account contexts for delivery ingestion', async () => {
    await inRollback(sql, async (tx) => {
      const accountId = await createUser(tx);
      const galleryId = await createGallery(tx, accountId);
      const repo = repoFor(tx);
      const owners = await repo.galleryOwners([galleryId, randomUUID()]);
      expect([...owners]).toEqual([[galleryId, accountId]]);
      const contexts = await repo.accountContexts([accountId]);
      expect(contexts.get(accountId)?.plan).toEqual(RATE_CARD_V1.free);

      const entries = rateDeliveryEvents({
        events: [
          {
            sourceId: 'jti-x:0-9',
            accountId,
            bytes: 10,
            servedAt: new Date('2026-11-09T00:00:00Z'),
          },
          {
            sourceId: 'jti-y:0-9',
            accountId,
            bytes: 5,
            servedAt: new Date('2026-11-09T00:00:01Z'),
          },
        ],
        accounts: contexts,
        deliveryBytesToDate: () => 0n,
      });
      expect(await repo.ledger.appendMany(entries)).toBe(2);
      const totals = await repo.deliveryTotals([{ accountId, periodStart: nov }]);
      expect(totals.get(`${accountId}|${nov.toISOString()}`)).toBe(15n);
    });
  });

  it('accrues storage once per window: cursor init, accrual, and lost-race rejection', async () => {
    await inRollback(sql, async (tx) => {
      const accountId = await createUser(tx);
      const galleryId = await createGallery(tx, accountId);
      const mediaId = randomUUID();
      await tx`
        insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status)
        values (${mediaId}, ${galleryId}, ${`originals/t/${galleryId}/${mediaId}/source`}, 'a.jpg',
                'image/jpeg', 4000, 'a0', 'uploaded')`;
      await tx`
        insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
        values (${mediaId}, 'w320', ${`derivatives/${galleryId}/${mediaId}/w320.webp`}, 'image/webp', 320, 240, 1000)`;
      const repo = repoFor(tx);
      const t0 = new Date('2026-11-09T10:07:00Z');
      const t1 = new Date('2026-11-09T11:07:00Z');

      const mine = async (at: Date) =>
        (await repo.storageAccrualCandidates(at, 10_000)).find((c) => c.accountId === accountId);
      const first = await mine(t0);
      expect(first).toMatchObject({ cursor: null, storedBytesNow: 5000 });
      const init = planStorageAccrual({ ...first!, windowEnd: t0, byteSecondsToDate: 0n })!;
      expect(await repo.commitStorageAccrual(accountId, null, init.entries, init.nextCursor)).toBe(
        true,
      );
      expect(await repo.commitStorageAccrual(accountId, null, [], init.nextCursor)).toBe(false);
      expect(await mine(t0)).toBeUndefined(); // already accrued through t0

      const second = await mine(t1);
      expect(second!.cursor).toEqual({ accruedThrough: t0, storedBytes: 5000 });
      const toDate = await repo.storageByteSecondsToDate(accountId, nov);
      const accrual = planStorageAccrual({ ...second!, windowEnd: t1, byteSecondsToDate: toDate })!;
      expect(
        await repo.commitStorageAccrual(accountId, t0, accrual.entries, accrual.nextCursor),
      ).toBe(true);
      // A concurrent run that read the same cursor loses the optimistic lock and writes nothing.
      expect(
        await repo.commitStorageAccrual(accountId, t0, accrual.entries, accrual.nextCursor),
      ).toBe(false);
      expect(await repo.storageByteSecondsToDate(accountId, nov)).toBe(5000n * 3600n);
    });
  });
});
