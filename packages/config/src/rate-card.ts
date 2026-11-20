import { BYTES_PER_GB } from './limits';

/**
 * Launch rate card (PRD §9.2). Money is integer micro-USD (1 USD = 1_000_000).
 * Confirmed by the owner: Pro `monthlyFeeMicroUsd` ($2), 20 GB-month included and (v2, 2026-11-16)
 * the $0.05/GB-month storage overage. Still Proposed and to be validated against unit economics
 * before live billing (PRD §17): the Free gallery count / 1 GB cap and the $10 default spending cap.
 * Lumra bills storage only: delivery (served bytes) is not tracked, capped or charged on any
 * plan (ADR-008). The authoritative, versioned copy lives in the `plan_rate_versions` table (T27; `plans` points
 * at the current version). `RATE_CARD_V1` / `RATE_CARD_V2` mirror the migration seeds exactly
 * (`packages/db/src/schema.test.ts` checks both); `RATE_CARD` is the current version and the
 * default/fallback for pure tests and when the database is unreachable.
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
  includedStorageGbMonth: number;
  storageOverageMicroUsdPerGbMonth: number | null;
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
    includedStorageGbMonth: 0,
    storageOverageMicroUsdPerGbMonth: null,
    defaultOverageCapMicroUsd: null,
    brandingVisible: true,
  },
  pro: {
    id: 'pro',
    rateVersion: 1,
    monthlyFeeMicroUsd: 2 * MICRO_USD_PER_USD,
    maxActiveGalleries: null,
    maxStorageBytes: null,
    includedStorageGbMonth: 20, // confirmed by owner 2026-11-09
    storageOverageMicroUsdPerGbMonth: 100_000, // $0.10 (v1; superseded by v2)
    defaultOverageCapMicroUsd: 10 * MICRO_USD_PER_USD,
    brandingVisible: false,
  },
};

/**
 * Rate card v2 (owner decision 2026-11-16): Pro storage overage $0.10 → $0.05 per GB-month.
 * Every other value equals v1. v1 stays defined: ledger rows already rated under it remain
 * reproducible (`plan_rate_versions` rows are immutable).
 */
export const RATE_CARD_V2: Record<PlanId, PlanRates> = {
  free: { ...RATE_CARD_V1.free, rateVersion: 2 },
  pro: {
    ...RATE_CARD_V1.pro,
    rateVersion: 2,
    storageOverageMicroUsdPerGbMonth: 50_000, // $0.05 (confirmed by owner 2026-11-16)
  },
};

/** The current rate card (what `plans.rate_version` points at). */
export const RATE_CARD: Record<PlanId, PlanRates> = RATE_CARD_V2;

/**
 * Rate-card-versioned billing conventions and spending-safeguard policy (PRD §9.2, §9.4, ADR-004).
 * Everything except the unit conventions is Proposed (PRD §17) and must be confirmed before
 * live billing. Logic in `@lumra/billing` reads these values; it never hard-codes them.
 */
export interface BillingPolicy {
  rateVersion: number;
  /** GB-month normalisation: byte-seconds / (1e9 × secondsPerBillingMonth). PRD §9.2: 30 × 86 400. */
  secondsPerBillingMonth: number;
  /** Proposed: `past_due` keeps galleries public for this long before suspension. */
  pastDueGraceMs: number;
  /** Proposed: media preserved for this long after public galleries are suspended. */
  retentionAfterSuspensionMs: number;
  /** Proposed: spend-cap alert thresholds, percent of the configured cap. */
  defaultAlertThresholdsPct: readonly number[];
  /**
   * Proposed: disclosed maximum overshoot of the overage cap caused by storage-metering lag:
   * max(cap × bps / 10 000, min). Reconciliation flags anything beyond it.
   */
  spendCapToleranceBps: number;
  spendCapToleranceMinMicroUsd: number;
  /** Proposed: highest overage cap an owner may set from /account (T32). The minimum is $0. */
  maxSpendCapMicroUsd: number;
  /** Reconciliation alert threshold: |Stripe − internal| / internal above this (bps, T31). */
  reconciliationDriftAlertBps: number;
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
  maxSpendCapMicroUsd: 500 * MICRO_USD_PER_USD, // $500
  reconciliationDriftAlertBps: 1_000, // 10 % (PLAN T31)
};
