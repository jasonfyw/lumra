import { BYTES_PER_GB } from './limits';

/**
 * Launch rate card (PRD §9.2). Money is integer micro-USD (1 USD = 1_000_000).
 * Only `monthlyFeeMicroUsd` for Pro is a confirmed decision; the rest are Proposed
 * and must be validated against unit economics before live billing (PRD §17).
 * The authoritative copy will live in the `plans` table (T27); this is the seed/default.
 */
export const MICRO_USD_PER_USD = 1_000_000;

export type PlanId = 'free' | 'pro';

export interface PlanRates {
  id: PlanId;
  rateVersion: number;
  monthlyFeeMicroUsd: number;
  maxActiveGalleries: number | null;
  /** Hard storage cap in bytes (Free only). */
  maxStorageBytes: number | null;
  /** Hard monthly delivery cap in bytes (Free only). */
  maxDeliveryBytesPerMonth: number | null;
  includedStorageGbMonth: number;
  includedDeliveryGb: number;
  storageOverageMicroUsdPerGbMonth: number | null;
  deliveryOverageMicroUsdPerGb: number | null;
  defaultOverageCapMicroUsd: number | null;
  brandingVisible: boolean;
}

export const RATE_CARD_V1: Record<PlanId, PlanRates> = {
  free: {
    id: 'free',
    rateVersion: 1,
    monthlyFeeMicroUsd: 0,
    maxActiveGalleries: 2,
    maxStorageBytes: 1 * BYTES_PER_GB,
    maxDeliveryBytesPerMonth: 3 * BYTES_PER_GB,
    includedStorageGbMonth: 0,
    includedDeliveryGb: 0,
    storageOverageMicroUsdPerGbMonth: null,
    deliveryOverageMicroUsdPerGb: null,
    defaultOverageCapMicroUsd: null,
    brandingVisible: true,
  },
  pro: {
    id: 'pro',
    rateVersion: 1,
    monthlyFeeMicroUsd: 2 * MICRO_USD_PER_USD,
    maxActiveGalleries: null,
    maxStorageBytes: null,
    maxDeliveryBytesPerMonth: null,
    includedStorageGbMonth: 2,
    includedDeliveryGb: 5,
    storageOverageMicroUsdPerGbMonth: 100_000, // $0.10
    deliveryOverageMicroUsdPerGb: 30_000, // $0.03
    defaultOverageCapMicroUsd: 10 * MICRO_USD_PER_USD,
    brandingVisible: false,
  },
};

/**
 * Rate-card-versioned billing conventions and spending-safeguard policy (PRD §9.2, §9.4, ADR-004).
 * Everything except the unit conventions is Proposed (PRD §17) and must be confirmed before
 * live billing. Logic in `@lumra/billing` reads these values; it never hard-codes them.
 */
export interface BillingPolicy {
  rateVersion: number;
  /** GB-month normalisation: byte-seconds / (1e9 × secondsPerBillingMonth). PRD §9.2: 30 × 86 400. */
  secondsPerBillingMonth: number;
  /** Proposed: `past_due` keeps public delivery for this long before suspension. */
  pastDueGraceMs: number;
  /** Proposed: media preserved for this long after public delivery is suspended. */
  retentionAfterSuspensionMs: number;
  /** Proposed: spend-cap alert thresholds, percent of the configured cap. */
  defaultAlertThresholdsPct: readonly number[];
  /**
   * Proposed: disclosed maximum overshoot of the overage cap caused by metering lag and transfers
   * already in flight: max(cap × bps / 10 000, min). Reconciliation flags anything beyond it.
   */
  spendCapToleranceBps: number;
  spendCapToleranceMinMicroUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const BILLING_POLICY_V1: BillingPolicy = {
  rateVersion: 1,
  secondsPerBillingMonth: 30 * 86_400,
  pastDueGraceMs: 7 * DAY_MS,
  retentionAfterSuspensionMs: 30 * DAY_MS,
  defaultAlertThresholdsPct: [50, 80, 100],
  spendCapToleranceBps: 1_000, // 10 %
  spendCapToleranceMinMicroUsd: 250_000, // $0.25
};
