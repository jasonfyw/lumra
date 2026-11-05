import { BILLING_POLICY_V1 } from '@lumra/config';
import { type LedgerEntry, type UsageMetric, USAGE_METRICS } from './ledger';
import { BillingArithmeticError, bytesToGbMicroUnits, storageGbMonthMicroUnits } from './units';

/**
 * Stripe Billing Meter export (ADR-004, T31). Meter values are integers in micro-units:
 * storage in micro GB-months, delivery in micro GB (decimal kB). The Stripe prices carry the
 * matching per-unit decimal amounts and the included allowance as a free first tier.
 *
 * Export is **cumulative**: each run converts the period-to-date ledger total to meter units
 * once and sends only the difference from what was already exported. Rounding therefore never
 * accumulates across daily runs: the sum of all deltas equals the rounded period total.
 */
export const METER_EVENT_NAMES: Readonly<Record<UsageMetric, string>> = {
  storage_byte_seconds: 'lumra_storage_gb_month_micro',
  delivery_bytes: 'lumra_delivery_gb_micro',
};

/** Body of `POST /v1/billing/meter_events`. `identifier` doubles as the request Idempotency-Key. */
export interface StripeMeterEvent {
  event_name: string;
  identifier: string;
  /** Unix seconds; the export window end, so replays are byte-identical. */
  timestamp: number;
  payload: { stripe_customer_id: string; value: string };
}

export interface MeterExportInput {
  stripeCustomerId: string;
  accountId: string;
  /** Export cut-off (exclusive of later entries); one export run per window. */
  windowEnd: Date;
  /** Ledger rows for the account; duplicates (same idempotency key) are tolerated. */
  entries: readonly LedgerEntry[];
  /** Meter units already exported, keyed by `meterCursorKey(metric, periodStart)`. */
  exported: Readonly<Record<string, bigint>>;
  secondsPerBillingMonth?: number;
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

export function toMeterUnits(
  metric: UsageMetric,
  quantity: bigint,
  secondsPerBillingMonth: number = BILLING_POLICY_V1.secondsPerBillingMonth,
): bigint {
  return metric === 'storage_byte_seconds'
    ? storageGbMonthMicroUnits(quantity, secondsPerBillingMonth)
    : bytesToGbMicroUnits(quantity);
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
      cumulative = toMeterUnits(total.metric, total.quantity, input.secondsPerBillingMonth);
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
    events.push({
      event_name: METER_EVENT_NAMES[total.metric],
      identifier: [
        input.accountId,
        total.metric,
        Math.floor(total.periodStart.getTime() / 1000),
        windowEndSec,
      ].join(':'),
      timestamp: windowEndSec,
      payload: { stripe_customer_id: input.stripeCustomerId, value: delta.toString() },
    });
  }
  return { events, cursors };
}
