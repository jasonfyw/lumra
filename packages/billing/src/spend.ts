import { BILLING_POLICY_V1, type BillingPolicy, type PlanRates } from '@lumra/config';
import { exceedsCapTolerance } from './admission';
import { type PeriodUsage, estimateOverageMicroUsd, rateInvoice } from './rating';
import { storageGbMonthMicroUnits, toNonNegativeBigInt } from './units';

/**
 * Spending cap control, alerts and invoice reconciliation (T31/T32, PRD §9.4–9.5). Pure.
 */

/**
 * Alert thresholds (percent of cap) the period's spend has reached, ascending. A threshold t is
 * reached when spend × 100 ≥ t × cap and spend is positive (a $0 cap alerts on the first billable
 * micro-dollar, never at zero). Dedupe by (account, period, threshold) is the caller's job.
 */
export function thresholdsReached(
  spendMicroUsd: number,
  capMicroUsd: number,
  thresholdsPct: readonly number[] = BILLING_POLICY_V1.defaultAlertThresholdsPct,
): number[] {
  const spend = toNonNegativeBigInt(spendMicroUsd, 'spendMicroUsd');
  const cap = toNonNegativeBigInt(capMicroUsd, 'capMicroUsd');
  if (spend === 0n) return [];
  return [...new Set(thresholdsPct)]
    .sort((a, b) => a - b)
    .filter((t) => spend * 100n >= toNonNegativeBigInt(t, 'threshold') * cap);
}

/** Thresholds reached now that have not been recorded for this period yet. */
export function newAlertThresholds(
  spendMicroUsd: number,
  capMicroUsd: number,
  thresholdsPct: readonly number[],
  alreadySent: readonly number[],
): number[] {
  const sent = new Set(alreadySent);
  return thresholdsReached(spendMicroUsd, capMicroUsd, thresholdsPct).filter((t) => !sent.has(t));
}

/**
 * Parses a dollar amount typed by a person ("10", "12.5", "$12.50") into integer micro-USD,
 * without floating point. At most two decimals; null when malformed.
 */
export function parseUsdToMicroUsd(text: string): number | null {
  const match = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  return dollars * 1_000_000 + cents * 10_000;
}

/** A cap the owner may set: whole cents, from $0 to the platform maximum. */
export function isValidSpendCap(
  capMicroUsd: number,
  policy: BillingPolicy = BILLING_POLICY_V1,
): boolean {
  return (
    Number.isSafeInteger(capMicroUsd) &&
    capMicroUsd >= 0 &&
    capMicroUsd <= policy.maxSpendCapMicroUsd &&
    capMicroUsd % 10_000 === 0
  );
}

export interface ReconciliationInput {
  plan: PlanRates;
  /** Internal ledger totals for the usage period the invoice bills (ignored for the first). */
  usage: PeriodUsage;
  /** Stripe invoice `subtotal` (cents, before invoice-level discounts and tax). */
  stripeSubtotalCents: number;
  /** `billing_reason === 'subscription_create'`: base fee only, no usage yet. */
  firstInvoice: boolean;
  capMicroUsd: number | null;
  policy?: BillingPolicy;
}

export interface Reconciliation {
  expectedCents: number;
  stripeCents: number;
  overageMicroUsd: number;
  /** |stripe − expected| / expected in basis points (expected 0 ⇒ difference × 10 000). */
  driftBps: number;
  /** Drift beyond the alert threshold and more than rounding (2 ¢). */
  flagged: boolean;
  /** Period overage beyond cap + disclosed tolerance: operator credit (ADR-004). */
  exceedsCapTolerance: boolean;
}

/**
 * Compares a Stripe invoice with the internal rating of the same period. A renewal invoice
 * carries the next period's base fee and the ended period's metered overage; the first invoice
 * only the base fee. Stripe rounds each line to cents, so a cent per line is expected noise.
 */
export function reconcileInvoice(input: ReconciliationInput): Reconciliation {
  const policy = input.policy ?? BILLING_POLICY_V1;
  const invoice = rateInvoice({
    plan: input.plan,
    storageGbMonthMicro: input.firstInvoice
      ? 0n
      : storageGbMonthMicroUnits(input.usage.storageByteSeconds, policy.secondsPerBillingMonth),
    deliveryBytes: input.firstInvoice ? 0 : input.usage.deliveryBytes,
    rateVersion: input.plan.rateVersion,
  });
  const overageMicroUsd = input.firstInvoice
    ? 0
    : estimateOverageMicroUsd(input.usage, input.plan, policy.secondsPerBillingMonth);
  const expectedCents = invoice.totalCents;
  const stripeCents = input.stripeSubtotalCents;
  const diff = Math.abs(stripeCents - expectedCents);
  const driftBps = expectedCents > 0 ? Math.round((diff * 10_000) / expectedCents) : diff * 10_000;
  return {
    expectedCents,
    stripeCents,
    overageMicroUsd,
    driftBps,
    flagged: driftBps > policy.reconciliationDriftAlertBps && diff > 2,
    exceedsCapTolerance:
      input.capMicroUsd !== null && exceedsCapTolerance(overageMicroUsd, input.capMicroUsd, policy),
  };
}
