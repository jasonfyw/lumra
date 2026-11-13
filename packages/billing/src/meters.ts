import {
  BILLING_POLICY_V1,
  BYTES_PER_GB,
  STRIPE_CATALOG_V1,
  type PlanRates,
  type StripeCatalog,
} from '@lumra/config';
import { type LedgerEntry, type UsageMetric, USAGE_METRICS } from './ledger';
import { BillingArithmeticError, divRoundHalfUp, maxBig, toNonNegativeBigInt } from './units';

/**
 * Stripe Billing Meter export (ADR-004 + 2026-11-13 amendment, T31). Meters carry **overage
 * only** as integers: storage in MB-months above the included GB-months
 * (`STRIPE_CATALOG_V1.meterUnitBytes` = 10⁶). The Stripe price is flat per unit. Storage is the
 * only metered quantity; delivery is not tracked or billed (ADR-008).
 *
 * Export is **cumulative**: each run converts the period-to-date ledger total to overage units
 * once (one half-up rounding) and sends only the difference from what was already exported, so
 * rounding never accumulates across runs: the sum of all deltas equals the rounded period total.
 */
export const METER_EVENT_NAMES: Readonly<Record<UsageMetric, string>> = {
  storage_byte_seconds: STRIPE_CATALOG_V1.meters.storageOverage,
};

/** Body of `POST /v1/billing/meter_events`. `identifier` doubles as the request Idempotency-Key. */
export interface StripeMeterEvent {
  event_name: string;
  identifier: string;
  /** Unix seconds: the window end, clamped into the usage period (replays are byte-identical). */
  timestamp: number;
  payload: { stripe_customer_id: string; value: string };
}

export interface MeterExportInput {
  stripeCustomerId: string;
  accountId: string;
  /** The plan the usage is billed under (allowances and whether overage exists at all). */
  plan: PlanRates;
  /** Export cut-off (exclusive of later entries); one export run per window. */
  windowEnd: Date;
  /** Ledger rows for the account; duplicates (same idempotency key) are tolerated. */
  entries: readonly LedgerEntry[];
  /** Meter units already exported, keyed by `meterCursorKey(metric, periodStart)`. */
  exported: Readonly<Record<string, bigint>>;
  /**
   * End of the billing period that starts at `periodStart`, when known. Events are timestamped
   * no later than one second before it, so usage exported after a period closed still lands on
   * that period's invoice (Stripe bills meter events by timestamp).
   */
  periodEndFor?: (periodStart: Date) => Date | null;
  secondsPerBillingMonth?: number;
  catalog?: StripeCatalog;
}

export interface MeterExportResult {
  events: StripeMeterEvent[];
  /** New cumulative exported units per cursor key, to persist with the events (`billing_exports`). */
  cursors: Record<string, bigint>;
}

export class MeterExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterExportError';
  }
}

export function meterCursorKey(metric: UsageMetric, periodStart: Date): string {
  return `${metric}|${periodStart.toISOString()}`;
}

/**
 * Overage meter units for a period-to-date ledger total: MB-months above the included
 * GB-months, rounded half up once. Plans without overage pricing (Free) always yield 0.
 */
export function toMeterUnits(
  metric: UsageMetric,
  quantity: bigint,
  plan: PlanRates,
  secondsPerBillingMonth: number = BILLING_POLICY_V1.secondsPerBillingMonth,
  unitBytes: number = STRIPE_CATALOG_V1.meterUnitBytes,
): bigint {
  const q = toNonNegativeBigInt(quantity, 'quantity');
  const unit = toNonNegativeBigInt(unitBytes, 'unitBytes');
  const gb = BigInt(BYTES_PER_GB);
  if (plan.storageOverageMicroUsdPerGbMonth === null) return 0n;
  const seconds = toNonNegativeBigInt(secondsPerBillingMonth, 'secondsPerBillingMonth');
  if (seconds === 0n) throw new BillingArithmeticError('secondsPerBillingMonth must be positive');
  const included = BigInt(plan.includedStorageGbMonth) * gb * seconds;
  return divRoundHalfUp(maxBig(0n, q - included), unit * seconds);
}

function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  return (
    a.accountId === b.accountId &&
    a.metric === b.metric &&
    a.quantity === b.quantity &&
    a.eventTime.getTime() === b.eventTime.getTime() &&
    a.periodStart.getTime() === b.periodStart.getTime()
  );
}

/**
 * Builds meter events for one account and window. Pure and order-independent: the same ledger
 * contents and cursors always produce identical events (same identifiers, values, timestamps).
 * The caller must persist the result before sending and resend the *stored* payload on retry
 * (never recompute), so a late ledger row cannot change the body behind a reused identifier.
 */
export function buildMeterEvents(input: MeterExportInput): MeterExportResult {
  const windowEndMs = input.windowEnd.getTime();
  if (!Number.isSafeInteger(windowEndMs)) throw new MeterExportError('invalid windowEnd');
  const windowEndSec = Math.floor(windowEndMs / 1000);
  const catalog = input.catalog ?? STRIPE_CATALOG_V1;
  const eventName: Record<UsageMetric, string> = {
    storage_byte_seconds: catalog.meters.storageOverage,
  };

  const unique = new Map<string, LedgerEntry>();
  for (const entry of input.entries) {
    if (entry.accountId !== input.accountId) {
      throw new MeterExportError('ledger entry belongs to another account');
    }
    if (entry.eventTime.getTime() > windowEndMs) continue;
    const existing = unique.get(entry.idempotencyKey);
    if (existing) {
      if (!sameEntry(existing, entry)) {
        throw new MeterExportError(`conflicting ledger rows for ${entry.idempotencyKey}`);
      }
      continue;
    }
    unique.set(entry.idempotencyKey, entry);
  }

  const totals = new Map<string, { metric: UsageMetric; periodStart: Date; quantity: bigint }>();
  for (const entry of unique.values()) {
    const key = meterCursorKey(entry.metric, entry.periodStart);
    const total = totals.get(key);
    if (total) total.quantity += entry.quantity;
    else
      totals.set(key, {
        metric: entry.metric,
        periodStart: entry.periodStart,
        quantity: entry.quantity,
      });
  }

  const metricOrder = (m: UsageMetric): number => USAGE_METRICS.indexOf(m);
  const ordered = [...totals.entries()].sort(([, a], [, b]) =>
    a.periodStart.getTime() !== b.periodStart.getTime()
      ? a.periodStart.getTime() - b.periodStart.getTime()
      : metricOrder(a.metric) - metricOrder(b.metric),
  );

  const events: StripeMeterEvent[] = [];
  const cursors: Record<string, bigint> = { ...input.exported };
  for (const [key, total] of ordered) {
    let cumulative: bigint;
    try {
      // A compensating row can make a raw total negative; it never exports below zero.
      cumulative = toMeterUnits(
        total.metric,
        maxBig(0n, total.quantity),
        input.plan,
        input.secondsPerBillingMonth,
        catalog.meterUnitBytes,
      );
    } catch (error) {
      if (error instanceof BillingArithmeticError) throw new MeterExportError(error.message);
      throw error;
    }
    const already = input.exported[key] ?? 0n;
    const delta = cumulative - already;
    if (delta < 0n) {
      throw new MeterExportError(`exported units exceed ledger total for ${key}; reconcile`);
    }
    cursors[key] = cumulative;
    if (delta === 0n) continue;
    const periodEnd = input.periodEndFor?.(total.periodStart) ?? null;
    const timestamp =
      periodEnd && periodEnd.getTime() <= windowEndMs
        ? Math.floor(periodEnd.getTime() / 1000) - 1
        : windowEndSec;
    events.push({
      event_name: eventName[total.metric],
      identifier: [
        input.accountId,
        total.metric,
        Math.floor(total.periodStart.getTime() / 1000),
        windowEndSec,
      ].join(':'),
      timestamp,
      payload: { stripe_customer_id: input.stripeCustomerId, value: delta.toString() },
    });
  }
  return { events, cursors };
}
