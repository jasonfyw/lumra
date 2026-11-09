import { BILLING_POLICY_V1, type BillingPolicy, type PlanRates } from '@lumra/config';
import {
  type LedgerEntry,
  METRIC_UNIT,
  type UsageMetric,
  buildLedgerEntry,
  storageWindowSourceId,
} from './ledger';
import { marginalOverageMicroUsd } from './rating';
import { integrateStorage } from './storage';
import { BillingArithmeticError, toNonNegativeBigInt } from './units';
import { type BillingPeriod, calendarMonthPeriod } from './usage-summary';

/**
 * Usage metering (T27, ADR-004): turns measured facts into `usage_ledger` rows. Pure — the
 * Worker jobs read inputs from the DB adapters in `@lumra/db` and write the returned rows.
 *
 * Metered actions and their ledger producers (every metric has exactly one):
 *  - `storage_byte_seconds` ← `planStorageAccrual` (hourly cron, sampled stored bytes)
 *  - `delivery_bytes`       ← `rateDeliveryEvents` (media gateway `delivery.served` events)
 */
export const METERED_ACTIONS: Readonly<Record<UsageMetric, string>> = {
  storage_byte_seconds: 'storage accrual (apps/worker cron → planStorageAccrual)',
  delivery_bytes: 'gateway delivery (delivery.served queue → rateDeliveryEvents)',
};

export interface StoredBillingPeriod {
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
}

/**
 * The billing period that contains `at`: the account's stored period when it covers `at`,
 * otherwise the UTC calendar month (the rule used until a subscription sets a period, T30).
 * Every ledger row is stamped with this period's start, which is what `/account`, admission and
 * the export read back.
 */
export function billingPeriodAt(
  account: StoredBillingPeriod | null | undefined,
  at: Date,
): BillingPeriod {
  const start = account?.billingPeriodStart;
  const end = account?.billingPeriodEnd;
  const t = at.getTime();
  if (start && end && start.getTime() <= t && t < end.getTime()) return { start, end };
  return calendarMonthPeriod(at);
}

// ---------------------------------------------------------------------------------------------
// Storage GB-month accrual
// ---------------------------------------------------------------------------------------------

export interface StorageAccrualCursor {
  /** Usage is accrued up to (excluding) this instant. */
  accruedThrough: Date;
  /** Stored bytes sampled at `accruedThrough`; held constant until the next sample. */
  storedBytes: number;
}

export interface StorageAccrualInput {
  accountId: string;
  account: StoredBillingPeriod | null;
  plan: PlanRates;
  /** `null` on the first run for an account: the cursor starts now and nothing is accrued. */
  cursor: StorageAccrualCursor | null;
  /** Stored bytes measured now (originals + generated derivatives, as on `/account`). */
  storedBytesNow: number;
  /** End of the window to accrue (the run time, truncated to the minute by the job). */
  windowEnd: Date;
  /**
   * Storage byte-seconds already in the ledger for the period containing
   * `cursor.accruedThrough` (`billingPeriodAt(account, cursor.accruedThrough)`). Only used for
   * the rows' estimated cost; later periods in the same window start from zero.
   */
  byteSecondsToDate: bigint;
  policy?: BillingPolicy;
  /** Guard against an unbounded loop over a very stale cursor (default 36 periods). */
  maxPeriods?: number;
}

export interface StorageAccrual {
  entries: LedgerEntry[];
  nextCursor: StorageAccrualCursor;
}

/**
 * Accrues storage for `[cursor.accruedThrough, windowEnd)` as sampled step integration: the
 * level measured at the previous run is held until this run (left Riemann sum), so the error is
 * bounded by |Δstored bytes| × run interval and never compounds. The window is split at billing
 * period boundaries so each row lands in exactly one period. One row per (account, segment);
 * its source id is the window itself, so re-running the same window is rejected by the ledger's
 * UNIQUE (metric, source_id) — and the cursor's optimistic lock prevents overlapping windows.
 *
 * Zero-usage segments produce no row but still advance the cursor.
 */
export function planStorageAccrual(input: StorageAccrualInput): StorageAccrual | null {
  const policy = input.policy ?? BILLING_POLICY_V1;
  toNonNegativeBigInt(input.storedBytesNow, 'storedBytesNow');
  const windowEnd = input.windowEnd;
  const next: StorageAccrualCursor = {
    accruedThrough: new Date(windowEnd.getTime()),
    storedBytes: input.storedBytesNow,
  };
  if (!input.cursor) return { entries: [], nextCursor: next };
  if (windowEnd.getTime() <= input.cursor.accruedThrough.getTime()) return null;

  const entries: LedgerEntry[] = [];
  const maxPeriods = input.maxPeriods ?? 36;
  let toDate = toNonNegativeBigInt(input.byteSecondsToDate, 'byteSecondsToDate');
  let segStart = input.cursor.accruedThrough;
  for (let i = 0; segStart.getTime() < windowEnd.getTime(); i++) {
    if (i >= maxPeriods) throw new BillingArithmeticError('storage accrual window too long');
    const period = billingPeriodAt(input.account, segStart);
    // A calendar-month fallback must also stop where a stored (subscription) period begins.
    const storedStart = input.account?.billingPeriodStart?.getTime();
    const cut =
      storedStart !== undefined && storedStart > segStart.getTime() ? storedStart : Infinity;
    const segEnd = new Date(Math.min(windowEnd.getTime(), period.end.getTime(), cut));
    const { byteSeconds } = integrateStorage([], segStart, segEnd, input.cursor.storedBytes);
    if (byteSeconds > 0n) {
      const after = toDate + byteSeconds;
      entries.push(
        buildLedgerEntry({
          accountId: input.accountId,
          metric: 'storage_byte_seconds',
          unit: METRIC_UNIT.storage_byte_seconds,
          quantity: byteSeconds,
          sourceId: storageWindowSourceId(input.accountId, segStart, segEnd),
          eventTime: segEnd,
          period,
          rateVersion: input.plan.rateVersion,
          estimatedCostMicroUsd: marginalOverageMicroUsd(
            input.plan,
            { storageByteSeconds: toDate, deliveryBytes: 0 },
            { storageByteSeconds: after, deliveryBytes: 0 },
            policy.secondsPerBillingMonth,
          ),
        }),
      );
    }
    // The next segment belongs to a new period, which starts with no storage rows yet.
    toDate = 0n;
    segStart = segEnd;
  }
  return { entries, nextCursor: next };
}

// ---------------------------------------------------------------------------------------------
// Delivery bytes
// ---------------------------------------------------------------------------------------------

export interface DeliveryEvent {
  /** The gateway event's `dedupeKey` (`{jti}:{start}-{end}`): the ledger source id. */
  sourceId: string;
  accountId: string;
  bytes: number;
  servedAt: Date;
}

export interface DeliveryAccountContext {
  account: StoredBillingPeriod | null;
  plan: PlanRates;
}

export interface RateDeliveryInput {
  events: readonly DeliveryEvent[];
  /** Billing context per account id; events of an account without one are an error. */
  accounts: ReadonlyMap<string, DeliveryAccountContext>;
  /**
   * Delivery bytes already in the ledger for (account, period start), for the estimated cost.
   * Missing keys count as zero.
   */
  deliveryBytesToDate: (accountId: string, periodStart: Date) => bigint;
  policy?: BillingPolicy;
}

/** Key for grouping per (account, billing period). */
export const accountPeriodKey = (accountId: string, periodStart: Date): string =>
  `${accountId}|${periodStart.toISOString()}`;

/**
 * Builds `delivery_bytes` ledger rows from gateway events (FR-D04: bytes of each successful
 * byte-bearing response). Duplicate source ids inside the batch are dropped (the DB UNIQUE
 * drops cross-batch duplicates). Each row's estimated cost is the marginal overage it adds on
 * top of the period total so far, so Free rows and rows inside the Pro allowance cost zero.
 */
export function rateDeliveryEvents(input: RateDeliveryInput): LedgerEntry[] {
  const policy = input.policy ?? BILLING_POLICY_V1;
  const running = new Map<string, bigint>();
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  const ordered = [...input.events].sort(
    (a, b) => a.servedAt.getTime() - b.servedAt.getTime() || (a.sourceId < b.sourceId ? -1 : 1),
  );
  for (const event of ordered) {
    if (seen.has(event.sourceId)) continue;
    seen.add(event.sourceId);
    const ctx = input.accounts.get(event.accountId);
    if (!ctx) throw new BillingArithmeticError(`no billing context for account`);
    const period = billingPeriodAt(ctx.account, event.servedAt);
    const key = accountPeriodKey(event.accountId, period.start);
    const before = running.get(key) ?? input.deliveryBytesToDate(event.accountId, period.start);
    const after = before + toNonNegativeBigInt(event.bytes, 'bytes');
    running.set(key, after);
    entries.push(
      buildLedgerEntry({
        accountId: event.accountId,
        metric: 'delivery_bytes',
        unit: METRIC_UNIT.delivery_bytes,
        quantity: event.bytes,
        sourceId: event.sourceId,
        eventTime: event.servedAt,
        period,
        rateVersion: ctx.plan.rateVersion,
        estimatedCostMicroUsd: marginalOverageMicroUsd(
          ctx.plan,
          { storageByteSeconds: 0n, deliveryBytes: before },
          { storageByteSeconds: 0n, deliveryBytes: after },
          policy.secondsPerBillingMonth,
        ),
      }),
    );
  }
  return entries;
}
