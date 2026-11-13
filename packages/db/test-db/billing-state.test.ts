/**
 * T28/T30/T33 integration tests: billing-state constraints, the outbox helper functions, the
 * delivery cutoff adapter (with `evaluateBillingSafeguards`) and the hourly sweep writes.
 * Everything runs in rolled-back transactions (usage_ledger is append-only).
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BYTES_PER_GB } from '@lumra/config';
import { evaluateBillingSafeguards } from '@lumra/billing';
import {
  createAccessStateRepository,
  createBillingStateRepository,
  createMeterExportRepository,
} from '../src';
import {
  CHECK_VIOLATION,
  DENIED,
  actAs,
  connect,
  createUser,
  expectSqlError,
  inRollback,
  slug,
  type Sql,
  type Tx,
} from './helpers';

let sql: Sql;
beforeAll(() => {
  sql = connect();
});
afterAll(async () => {
  await sql.end();
});

const repoFor = (tx: Tx) => createBillingStateRepository(tx as unknown as postgres.Sql);

async function published(tx: Tx, ownerId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, status, published_at)
    values (${ownerId}, ${slug()}, 'published', now()) returning id`;
  return row!.id;
}

const outboxFor = (tx: Tx, ids: string[]) =>
  tx<{ event_name: string; aggregate_id: string; payload: Record<string, unknown> }[]>`
    select event_name, aggregate_id, payload from public.job_outbox
    where aggregate_id = any(${`{${ids.join(',')}}`}::uuid[]) order by created_at, id`;

async function deliveryRow(tx: Tx, accountId: string, bytes: number, periodStart: Date) {
  await tx`
    insert into public.usage_ledger (account_id, metric, quantity_micro_units, unit, source_id,
                                     event_time, period_start, rating_version)
    values (${accountId}, 'delivery_bytes', ${bytes}, 'bytes', ${randomUUID()}, now(),
            ${periodStart}, 1)`;
}

describe('billing_accounts constraints (T30/T33)', () => {
  it('status timestamps and the pause pair are structural', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.billing_accounts set status = 'past_due' where user_id = ${user}`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.billing_accounts set status = 'canceled' where user_id = ${user}`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`update public.billing_accounts set delivery_paused_reason = 'spend_cap' where user_id = ${user}`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) =>
          sp`update public.billing_accounts set delivery_paused_reason = 'other', delivery_paused_at = now()
           where user_id = ${user}`,
      );
      await tx`update public.billing_accounts set status = 'past_due', past_due_since = now()
               where user_id = ${user}`;
    });
  });

  it('owners can read their billing state but never write it or call the outbox helpers', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      await actAs(tx, 'authenticated', user);
      const [row] = await tx<{ delivery_paused_reason: string | null }[]>`
        select delivery_paused_reason from public.billing_accounts where user_id = ${user}`;
      expect(row).toEqual({ delivery_paused_reason: null });
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`update public.billing_accounts set status = 'active' where user_id = ${user}`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) => sp`select public.enqueue_owner_access_sync(${user}::uuid, 't')`,
      );
      await expectSqlError(
        tx,
        DENIED,
        (sp) =>
          sp`select public.enqueue_account_email(${user}::uuid, 'pro_activated', 'k', '{}'::jsonb, 't')`,
      );
      await expectSqlError(tx, DENIED, (sp) => sp`select * from public.provider_webhook_events`);
    });
  });
});

describe('outbox helpers', () => {
  it('re-sync only published, non-deleted galleries; emails are once-only by dedupe key', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const a = await published(tx, user);
      await tx`insert into public.galleries (owner_id, slug) values (${user}, ${slug()})`; // draft
      const [synced] = await tx<{ n: number }[]>`
        select public.enqueue_owner_access_sync(${user}::uuid, 'trace') as n`;
      expect(synced!.n).toBe(1);
      const rows = await outboxFor(tx, [a]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_name: 'gallery.access_changed',
        payload: { type: 'gallery.access_changed', galleryId: a, traceId: 'trace' },
      });

      const send = () => tx<{ inserted: boolean }[]>`
        select public.enqueue_account_email(${user}::uuid, 'payment_failed', ${`email:x:${user}`},
          '{"a":1}'::jsonb, 't') as inserted`;
      expect((await send())[0]!.inserted).toBe(true);
      expect((await send())[0]!.inserted).toBe(false);
      const emails = await outboxFor(tx, [user]);
      expect(emails).toHaveLength(1);
      expect(emails[0]!.payload).toMatchObject({
        type: 'email.send',
        accountId: user,
        template: 'payment_failed',
        data: { a: 1 },
      });
    });
  });
});

describe('delivery safety cutoff (T28)', () => {
  it('pauses a Free account at 3 GB, mirrors it into the access state, and resumes next period', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const gallery = await published(tx, user);
      const repo = repoFor(tx);
      const now = new Date();
      const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await deliveryRow(tx, user, 3 * BYTES_PER_GB - 1, period);

      const [ctx] = await repo.safeguardContexts([user], now);
      expect(ctx).toMatchObject({
        accountId: user,
        plan: { id: 'free' },
        deliveryPausedReason: null,
        usage: { deliveryBytesToDate: 3 * BYTES_PER_GB - 1, storageByteSecondsToDate: 0n },
      });
      expect(ctx!.period.start).toEqual(period);
      const idle = await evaluateBillingSafeguards([user], { store: repo, now, traceId: 't' });
      expect(idle).toMatchObject({ evaluated: 1, paused: 0 });

      await deliveryRow(tx, user, 1, period);
      const paused = await evaluateBillingSafeguards([user], { store: repo, now, traceId: 't' });
      expect(paused).toMatchObject({ paused: 1 });
      const [row] = await tx<{ r: string; at: Date | null }[]>`
        select delivery_paused_reason as r, delivery_paused_at as at
        from public.billing_accounts where user_id = ${user}`;
      expect(row!.r).toBe('free_delivery_cap');
      expect(row!.at).not.toBeNull();
      expect((await outboxFor(tx, [gallery])).map((r) => r.event_name)).toEqual([
        'gallery.access_changed',
      ]);
      expect((await outboxFor(tx, [user])).map((r) => r.payload.template)).toEqual([
        'delivery_paused',
      ]);
      const access = await createAccessStateRepository(
        tx as unknown as postgres.Sql,
      ).getGalleryAccess(gallery);
      expect(access?.billing?.deliveryPausedReason).toBe('free_delivery_cap');

      // Stale compare-and-set loses, writing nothing.
      expect(await repo.setDeliveryPause(user, null, 'spend_cap', { traceId: 't' })).toBe(false);

      // Next calendar month: the allowance is back and the pause lifts.
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
      const resumed = await evaluateBillingSafeguards([user], {
        store: repo,
        now: next,
        traceId: 't',
      });
      expect(resumed).toMatchObject({ resumed: 1 });
      const [after] = await tx<{ r: string | null }[]>`
        select delivery_paused_reason as r from public.billing_accounts where user_id = ${user}`;
      expect(after!.r).toBeNull();
    });
  });
});

describe('hourly sweep writes (T33)', () => {
  it('lists past_due/canceled/paused/Pro accounts with their footprint and applies CAS transitions', async () => {
    await inRollback(sql, async (tx) => {
      const pastDue = await createUser(tx);
      const plain = await createUser(tx);
      const since = new Date(Date.now() - 8 * 86_400_000);
      await tx`update public.billing_accounts set status = 'past_due', past_due_since = ${since}
               where user_id = ${pastDue}`;
      await tx`update public.profiles set plan_id = 'pro' where user_id = ${pastDue}`;
      await published(tx, pastDue);
      const repo = repoFor(tx);
      const ids = (await repo.sweepCandidates(null, 1000)).map((c) => c.accountId);
      expect(ids).toContain(pastDue);
      expect(ids).not.toContain(plain);
      const candidate = (await repo.sweepCandidates(null, 1000)).find(
        (c) => c.accountId === pastDue,
      );
      expect(candidate).toMatchObject({ status: 'past_due', activeGalleries: 1, storedBytes: 0 });

      const restrictedSince = new Date(since.getTime() + 7 * 86_400_000);
      const next = { status: 'restricted' as const, restrictedSince, canceledAt: null };
      const notice = { template: 'delivery_suspended', dedupeKey: `email:ds:${pastDue}` };
      expect(
        await repo.applySweep(pastDue, 'past_due', next, { traceId: 't', notices: [notice] }),
      ).toBe(true);
      // Second run: the expected status no longer matches → no write, no duplicate notice.
      expect(
        await repo.applySweep(pastDue, 'past_due', next, { traceId: 't', notices: [notice] }),
      ).toBe(false);
      const [row] = await tx<{ status: string; restricted_since: Date; past_due_since: Date }[]>`
        select status, restricted_since, past_due_since from public.billing_accounts
        where user_id = ${pastDue}`;
      expect(row).toEqual({
        status: 'restricted',
        restricted_since: restrictedSince,
        past_due_since: since,
      });
      expect((await outboxFor(tx, [pastDue])).map((r) => r.payload.template)).toEqual([
        'delivery_suspended',
      ]);
    });
  });
});

describe('spend-cap alerts (T32)', () => {
  it('records each threshold once per period and enqueues one email each', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const repo = repoFor(tx);
      const period = new Date('2026-11-04T09:30:00Z');
      const details = { spendMicroUsd: 8_500_000, capMicroUsd: 10_000_000, traceId: 't' };
      expect(await repo.recordSpendAlerts(user, period, [50, 80], details)).toEqual([50, 80]);
      expect(await repo.recordSpendAlerts(user, period, [50, 80, 100], details)).toEqual([100]);
      expect(await repo.recordSpendAlerts(user, period, [100], details)).toEqual([]);
      const emails = await outboxFor(tx, [user]);
      expect(emails.map((e) => e.payload.template)).toEqual([
        'spend_cap_alert',
        'spend_cap_alert',
        'spend_cap_alert',
      ]);
      const [ctx] = await repo.safeguardContexts([user], new Date('2026-11-13T00:00:00Z'));
      // Free account: the calendar period differs, so this period's alerts are not its own.
      expect(ctx!.alertsSent).toEqual([]);

      await actAs(tx, 'authenticated', user);
      const visible = await tx`select threshold_pct from public.billing_alerts`;
      expect(visible).toHaveLength(3);
    });
  });
});

describe('meter export persistence (T31)', () => {
  it('stores events and cursors atomically with compare-and-set, then tracks sending', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      await tx`update public.billing_accounts set stripe_customer_id = ${`cus_${user.slice(0, 8)}`}
               where user_id = ${user}`;
      const start = new Date('2026-11-04T09:30:00Z');
      const end = new Date('2026-12-04T09:30:00Z');
      await tx`insert into public.billing_periods (account_id, period_start, period_end, stripe_subscription_id)
               values (${user}, ${start}, ${end}, 'sub_1')`;
      await deliveryRow(tx, user, 6 * BYTES_PER_GB, start);
      const repo = createMeterExportRepository(tx as unknown as postgres.Sql);

      const periods = await repo.exportPeriods({ endedAfter: new Date('2026-11-01'), limit: 100 });
      expect(periods.filter((p) => p.accountId === user)).toEqual([
        {
          accountId: user,
          stripeCustomerId: `cus_${user.slice(0, 8)}`,
          periodStart: start,
          periodEnd: end,
        },
      ]);
      const closed = await repo.exportPeriods({
        endedAfter: new Date('2026-11-01'),
        closedFrom: new Date('2026-12-04T08:00:00Z'),
        closedTo: new Date('2026-12-04T10:00:00Z'),
        limit: 100,
      });
      expect(closed.some((p) => p.accountId === user)).toBe(true);
      const entries = await repo.ledgerFor(user, [start], new Date(Date.now() + 60_000));
      expect(entries).toHaveLength(1);

      const event = {
        event_name: 'lumra_delivery_overage',
        identifier: `${user}:delivery_bytes:${start.getTime() / 1000}:1764000000`,
        timestamp: 1_764_000_000,
        payload: { stripe_customer_id: 'cus_1', value: '1000' },
      };
      const key = `delivery_bytes|${start.toISOString()}`;
      const record = (previous: Record<string, bigint>, next: Record<string, bigint>) =>
        repo.recordExport(
          user,
          [{ event, metric: 'delivery_bytes', periodStart: start }],
          previous,
          next,
          new Date('2026-11-24T00:00:00Z'),
        );
      expect(await record({}, { [key]: 1000n })).toBe(true);
      expect(await repo.cursors(user)).toEqual({ [key]: 1000n });
      // A stale run (still thinks nothing was exported) writes nothing.
      expect(await record({}, { [key]: 1000n })).toBe(false);
      expect(await record({ [key]: 999n }, { [key]: 1500n })).toBe(false);

      const unsent = (await repo.unsent(100, 20)).filter((u) => u.accountId === user);
      expect(unsent).toHaveLength(1);
      expect(unsent[0]!.event).toEqual(event);
      await repo.markFailed(unsent[0]!.id, 'http_500', false);
      expect((await repo.unsent(100, 20)).filter((u) => u.accountId === user)).toHaveLength(1);
      await repo.markSent(unsent[0]!.id);
      expect((await repo.unsent(100, 20)).filter((u) => u.accountId === user)).toHaveLength(0);

      await actAs(tx, 'authenticated', user);
      await expectSqlError(tx, DENIED, (sp) => sp`select * from public.billing_meter_cursors`);
      await expectSqlError(tx, DENIED, (sp) => sp`select * from public.billing_periods`);
    });
  });
});
