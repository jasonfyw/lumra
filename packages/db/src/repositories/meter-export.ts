/**
 * SERVER-ONLY. Persistence for the daily Stripe meter export (T31, ADR-004 + amendment).
 *
 * Contract: built events and the new cumulative cursors are written in ONE transaction
 * (`recordExport`) before anything is sent; the sender only ever resends the stored payload, so
 * a late ledger row can never change the body behind an identifier Stripe has already seen.
 */
import type postgres from 'postgres';
import {
  type LedgerEntry,
  type StripeMeterEvent,
  type UsageMetric,
  ledgerIdempotencyKey,
  meterCursorKey,
} from '@lumra/billing';

/** A paid period (`billing_periods`) whose usage may be exported. */
export interface ExportPeriod {
  accountId: string;
  stripeCustomerId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface StoredMeterExport {
  id: string;
  accountId: string;
  identifier: string;
  attemptCount: number;
  event: StripeMeterEvent;
}

export interface MeterExportRepository {
  /**
   * Paid periods of accounts with a Stripe customer that ended after `endedAfter` (still open or
   * recently closed), optionally only those that ended in `[closedFrom, closedTo)`.
   */
  exportPeriods(options: {
    endedAfter: Date;
    closedFrom?: Date;
    closedTo?: Date;
    limit: number;
  }): Promise<ExportPeriod[]>;
  /** Ledger rows of `accountId` stamped with one of `periodStarts`, up to `until`. */
  ledgerFor(accountId: string, periodStarts: readonly Date[], until: Date): Promise<LedgerEntry[]>;
  /** Cumulative exported units keyed by `meterCursorKey`. */
  cursors(accountId: string): Promise<Record<string, bigint>>;
  /**
   * Atomically stores the events (`billing_exports`, idempotency key = identifier) and moves the
   * cursors from `previous` to `next` (compare-and-set). False — nothing written — when another
   * run moved a cursor first.
   */
  recordExport(
    accountId: string,
    events: readonly { event: StripeMeterEvent; metric: UsageMetric; periodStart: Date }[],
    previous: Readonly<Record<string, bigint>>,
    next: Readonly<Record<string, bigint>>,
    windowEnd: Date,
  ): Promise<boolean>;
  /** Unsent events, oldest first (status pending/failed below `maxAttempts`). */
  unsent(limit: number, maxAttempts: number): Promise<StoredMeterExport[]>;
  markSent(id: string): Promise<void>;
  /** `permanent` (a 4xx Stripe will never accept) parks the row beyond any retry budget. */
  markFailed(id: string, errorClass: string, permanent: boolean): Promise<void>;
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/** `metric|periodStartIso` → parts. */
function parseCursorKey(key: string): { metric: UsageMetric; periodStart: Date } {
  const [metric, iso] = key.split('|') as [UsageMetric, string];
  return { metric, periodStart: new Date(iso) };
}

export function createMeterExportRepository(sql: postgres.Sql): MeterExportRepository {
  const atomically = (fn: (tx: postgres.TransactionSql) => Promise<boolean>) => {
    const maybeTx = sql as unknown as Partial<postgres.TransactionSql>;
    return (
      typeof maybeTx.savepoint === 'function' ? maybeTx.savepoint(fn) : sql.begin(fn)
    ) as Promise<boolean>;
  };

  return {
    async exportPeriods({ endedAfter, closedFrom, closedTo, limit }) {
      const rows = await sql<
        {
          account_id: string;
          stripe_customer_id: string;
          period_start: Date | string;
          period_end: Date | string;
        }[]
      >`
        select bp.account_id, ba.stripe_customer_id, bp.period_start, bp.period_end
        from public.billing_periods bp
        join public.billing_accounts ba on ba.user_id = bp.account_id
        where ba.stripe_customer_id is not null
          and bp.period_end > ${endedAfter.toISOString()}::timestamptz
          and (${closedFrom?.toISOString() ?? null}::timestamptz is null
               or bp.period_end >= ${closedFrom?.toISOString() ?? null}::timestamptz)
          and (${closedTo?.toISOString() ?? null}::timestamptz is null
               or bp.period_end < ${closedTo?.toISOString() ?? null}::timestamptz)
        order by bp.account_id, bp.period_start
        limit ${limit}`;
      return rows.map((r) => ({
        accountId: r.account_id,
        stripeCustomerId: r.stripe_customer_id,
        periodStart: toDate(r.period_start),
        periodEnd: toDate(r.period_end),
      }));
    },

    async ledgerFor(accountId, periodStarts, until) {
      if (periodStarts.length === 0) return [];
      const starts = `{${periodStarts.map((d) => `"${d.toISOString()}"`).join(',')}}`;
      const rows = await sql<
        {
          metric: UsageMetric;
          quantity: string;
          source_id: string;
          event_time: Date | string;
          period_start: Date | string;
          rating_version: number;
          estimated_cost: string;
        }[]
      >`
        select metric, quantity_micro_units::text as quantity, source_id, event_time, period_start,
               rating_version, estimated_cost_micro_usd::text as estimated_cost
        from public.usage_ledger
        where account_id = ${accountId}::uuid
          and period_start = any(${starts}::timestamptz[])
          and event_time <= ${until.toISOString()}::timestamptz`;
      return rows.map((r) => ({
        idempotencyKey: ledgerIdempotencyKey(r.metric, r.source_id),
        accountId,
        metric: r.metric,
        quantity: BigInt(r.quantity),
        unit: 'byte_second',
        sourceId: r.source_id,
        eventTime: toDate(r.event_time),
        periodStart: toDate(r.period_start),
        rateVersion: r.rating_version,
        estimatedCostMicroUsd: Number(r.estimated_cost),
      }));
    },

    async cursors(accountId) {
      const rows = await sql<
        { metric: UsageMetric; period_start: Date | string; exported_units: string }[]
      >`
        select metric, period_start, exported_units::text as exported_units
        from public.billing_meter_cursors where account_id = ${accountId}::uuid`;
      const out: Record<string, bigint> = {};
      for (const r of rows) {
        out[meterCursorKey(r.metric, toDate(r.period_start))] = BigInt(r.exported_units);
      }
      return out;
    },

    recordExport(accountId, events, previous, next, windowEnd) {
      return atomically(async (tx) => {
        for (const [key, units] of Object.entries(next)) {
          const before = previous[key];
          if (before === units) continue;
          const { metric, periodStart } = parseCursorKey(key);
          const moved =
            before === undefined
              ? await tx`
                  insert into public.billing_meter_cursors (account_id, metric, period_start, exported_units)
                  values (${accountId}::uuid, ${metric}::public.usage_metric,
                          ${periodStart.toISOString()}::timestamptz, ${units.toString()}::bigint)
                  on conflict do nothing
                  returning account_id`
              : await tx`
                  update public.billing_meter_cursors set exported_units = ${units.toString()}::bigint
                  where account_id = ${accountId}::uuid and metric = ${metric}::public.usage_metric
                    and period_start = ${periodStart.toISOString()}::timestamptz
                    and exported_units = ${before.toString()}::bigint
                  returning account_id`;
          // Another run moved this cursor: abort the whole transaction (nothing recorded).
          if (moved.length === 0) throw new CursorConflict();
        }
        for (const { event, metric, periodStart } of events) {
          await tx`
            insert into public.billing_exports
              (billing_account_id, ledger_cursor, idempotency_key, status, event_name, metric,
               period_start, window_end, meter_value, payload)
            values (${accountId}::uuid, ${meterCursorKey(metric, periodStart)}, ${event.identifier},
                    'pending', ${event.event_name}, ${metric}::public.usage_metric,
                    ${periodStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz,
                    ${event.payload.value}::bigint, ${JSON.stringify(event)}::text::jsonb)
            on conflict (idempotency_key) do nothing`;
        }
        return true;
      }).catch((error: unknown) => {
        if (error instanceof CursorConflict) return false;
        throw error;
      });
    },

    async unsent(limit, maxAttempts) {
      const rows = await sql<
        {
          id: string;
          billing_account_id: string;
          idempotency_key: string;
          attempt_count: number;
          payload: StripeMeterEvent;
        }[]
      >`
        select id, billing_account_id, idempotency_key, attempt_count, payload
        from public.billing_exports
        where status <> 'sent' and payload is not null and attempt_count < ${maxAttempts}
        order by created_at, id
        limit ${limit}`;
      return rows.map((r) => ({
        id: r.id,
        accountId: r.billing_account_id,
        identifier: r.idempotency_key,
        attemptCount: r.attempt_count,
        event: r.payload,
      }));
    },

    async markSent(id) {
      await sql`
        update public.billing_exports
        set status = 'sent', sent_at = now(), last_error = null, attempt_count = attempt_count + 1
        where id = ${id}::uuid and status <> 'sent'`;
    },

    async markFailed(id, errorClass, permanent) {
      await sql`
        update public.billing_exports
        set status = 'failed', last_error = ${errorClass.slice(0, 200)},
            attempt_count = attempt_count + ${permanent ? 1_000 : 1}
        where id = ${id}::uuid and status <> 'sent'`;
    },
  };
}

class CursorConflict extends Error {
  constructor() {
    super('meter cursor moved by another run');
    this.name = 'CursorConflict';
  }
}
