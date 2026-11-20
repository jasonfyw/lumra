import type { PlanRates } from '@lumra/config';
import { toNonNegativeBigInt } from './units';

/**
 * Account usage summary (PRD §4 `/account`, FR-N03). Pure: callers pass totals read from the
 * database; nothing here touches I/O, so web and Workers derive the same figures.
 */

export interface BillingPeriod {
  start: Date;
  end: Date;
}

/** UTC calendar month containing `now`: the period used until a subscription sets one (T30). */
export function calendarMonthPeriod(now: Date): BillingPeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** The account's stored billing period, or the UTC calendar month when none is set. */
export function currentBillingPeriod(
  account: { billingPeriodStart: Date | null; billingPeriodEnd: Date | null } | null | undefined,
  now: Date,
): BillingPeriod {
  return account?.billingPeriodStart && account.billingPeriodEnd
    ? { start: account.billingPeriodStart, end: account.billingPeriodEnd }
    : calendarMonthPeriod(now);
}

export interface UsageMeterSummary {
  usedBytes: number | null;
  limitBytes: number | null;
  percentUsed: number | null;
  tracked: boolean;
}

/** Whole percent of `limit` used, rounded down and clamped to 0–100 (integer math only). */
export function percentOfLimit(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  const u = toNonNegativeBigInt(used, 'used');
  const l = toNonNegativeBigInt(limit, 'limit');
  if (l === 0n) return u === 0n ? 0 : 100;
  const pct = (u * 100n) / l;
  return Number(pct > 100n ? 100n : pct);
}

function meter(used: number | null, limit: number | null): UsageMeterSummary {
  if (used === null)
    return { usedBytes: null, limitBytes: limit, percentUsed: null, tracked: false };
  return {
    usedBytes: used,
    limitBytes: limit,
    percentUsed: percentOfLimit(used, limit),
    tracked: true,
  };
}

export interface UsageSummaryInput {
  plan: Pick<PlanRates, 'maxStorageBytes'>;
  storedBytes: number;
}

/** Storage only: delivery is not tracked (ADR-008). */
export interface UsageSummary {
  storage: UsageMeterSummary;
}

export function summarizeUsage(input: UsageSummaryInput): UsageSummary {
  return { storage: meter(input.storedBytes, input.plan.maxStorageBytes) };
}
