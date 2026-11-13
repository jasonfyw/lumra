import type { PlanRates } from '@lumra/config';
import {
  MICRO,
  divRoundHalfUp,
  maxBig,
  microUsdToCents,
  storageGbMonthMicroUnits,
  toNonNegativeBigInt,
  toSafeNumber,
} from './units';

/**
 * Invoice rating (PRD §9.2–9.3). All commercial values come from the `PlanRates` passed in
 * (seeded from `RATE_CARD_V1`, later the `plans` table); nothing is hard-coded here.
 *
 * Each overage line is rated independently and rounded half up to whole micro-USD; the total is
 * the exact sum of the rounded lines. Cents are derived per line (half up) and the invoice total
 * in cents is the sum of line cents, so the lines always add up on the customer's invoice.
 */

export class RateVersionMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Rate version mismatch: plan is v${expected}, usage was rated for v${actual}`);
    this.name = 'RateVersionMismatchError';
  }
}

export type InvoiceLineKind = 'base_fee' | 'storage_overage';

export interface InvoiceLine {
  kind: InvoiceLineKind;
  /** Quantity charged: months (base fee) or micro GB-months (storage). */
  quantity: bigint;
  unit: 'month' | 'gb_month_micro';
  /** Price per whole unit: per month or per GB-month. */
  unitPriceMicroUsd: number;
  amountMicroUsd: number;
  amountCents: number;
}

export interface Invoice {
  planId: PlanRates['id'];
  rateVersion: number;
  lines: InvoiceLine[];
  totalMicroUsd: number;
  totalCents: number;
}

export interface RateInvoiceInput {
  plan: PlanRates;
  /** Period storage in micro GB-months (see `storageGbMonthMicroUnits`). */
  storageGbMonthMicro: number | bigint;
  /** The rate version the usage was recorded under; must equal `plan.rateVersion`. */
  rateVersion: number;
}

export interface OverageBreakdown {
  storageOverageGbMonthMicro: bigint;
  storageOverageMicroUsd: number;
}

/** True when the plan can bill usage above its allowance (Free never can). */
export function planBillsOverage(plan: PlanRates): boolean {
  return plan.storageOverageMicroUsdPerGbMonth !== null;
}

/** Overage quantities and amounts for a period's usage. Free plans always yield zeros. */
export function computeOverage(
  plan: PlanRates,
  storageGbMonthMicro: number | bigint,
): OverageBreakdown {
  const storage = toNonNegativeBigInt(storageGbMonthMicro, 'storageGbMonthMicro');

  let storageOverageGbMonthMicro = 0n;
  let storageOverageMicroUsd = 0n;
  if (plan.storageOverageMicroUsdPerGbMonth !== null) {
    const included =
      toNonNegativeBigInt(plan.includedStorageGbMonth, 'includedStorageGbMonth') * MICRO;
    const rate = toNonNegativeBigInt(plan.storageOverageMicroUsdPerGbMonth, 'storage rate');
    storageOverageGbMonthMicro = maxBig(0n, storage - included);
    storageOverageMicroUsd = divRoundHalfUp(storageOverageGbMonthMicro * rate, MICRO);
  }

  return {
    storageOverageGbMonthMicro,
    storageOverageMicroUsd: toSafeNumber(storageOverageMicroUsd, 'storageOverageMicroUsd'),
  };
}

export function rateInvoice(input: RateInvoiceInput): Invoice {
  const { plan } = input;
  if (input.rateVersion !== plan.rateVersion) {
    throw new RateVersionMismatchError(plan.rateVersion, input.rateVersion);
  }
  const overage = computeOverage(plan, input.storageGbMonthMicro);
  const baseFee = toSafeNumber(toNonNegativeBigInt(plan.monthlyFeeMicroUsd, 'monthlyFeeMicroUsd'));

  const lines: InvoiceLine[] = [
    {
      kind: 'base_fee',
      quantity: 1n,
      unit: 'month',
      unitPriceMicroUsd: baseFee,
      amountMicroUsd: baseFee,
      amountCents: microUsdToCents(baseFee),
    },
  ];
  if (plan.storageOverageMicroUsdPerGbMonth !== null) {
    lines.push({
      kind: 'storage_overage',
      quantity: overage.storageOverageGbMonthMicro,
      unit: 'gb_month_micro',
      unitPriceMicroUsd: plan.storageOverageMicroUsdPerGbMonth,
      amountMicroUsd: overage.storageOverageMicroUsd,
      amountCents: microUsdToCents(overage.storageOverageMicroUsd),
    });
  }

  return {
    planId: plan.id,
    rateVersion: plan.rateVersion,
    lines,
    totalMicroUsd: lines.reduce((sum, line) => sum + line.amountMicroUsd, 0),
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
  };
}

/** Period-to-date usage in raw ledger units. */
export interface PeriodUsage {
  storageByteSeconds: bigint;
}

/**
 * Estimated overage (base fee and taxes excluded, PRD §9.4) for usage so far. Uses exactly the
 * same rounding as `rateInvoice`, so the estimate equals the invoice's overage lines.
 */
export function estimateOverageMicroUsd(
  usage: PeriodUsage,
  plan: PlanRates,
  secondsPerBillingMonth?: number,
): number {
  const overage = computeOverage(
    plan,
    storageGbMonthMicroUnits(usage.storageByteSeconds, secondsPerBillingMonth),
  );
  return overage.storageOverageMicroUsd;
}

/**
 * Incremental estimated cost of moving from `before` to `after` usage, for the
 * `usage_ledger.estimated_cost_micro_usd` column. Never negative (usage is monotonic).
 */
export function marginalOverageMicroUsd(
  plan: PlanRates,
  before: PeriodUsage,
  after: PeriodUsage,
  secondsPerBillingMonth?: number,
): number {
  const diff =
    estimateOverageMicroUsd(after, plan, secondsPerBillingMonth) -
    estimateOverageMicroUsd(before, plan, secondsPerBillingMonth);
  return Math.max(0, diff);
}
