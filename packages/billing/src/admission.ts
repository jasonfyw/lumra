import { BILLING_POLICY_V1, type BillingPolicy, type PlanRates } from '@lumra/config';
import { type BillingAccountState, deriveBillingRestrictions } from './account';
import { estimateOverageMicroUsd } from './rating';
import { BillingArithmeticError, divCeil, toNonNegativeBigInt, toSafeNumber } from './units';

/**
 * Spending safeguards (PRD §9.4, §5.2 FR-G07). These are pure pre-checks; the authoritative
 * decision runs again inside the reservation transaction (T28/T32) with the same inputs.
 *
 * Admission is conservative: it assumes every byte stored now (plus every pending and requested
 * upload) stays stored until the period ends, and every pending/requested archive is fully
 * downloaded. Organic gallery views cannot be reserved in advance; those are bounded by the
 * delivery cutoff (`checkDeliveryAllowance`) and the disclosed cap tolerance.
 */

export type AdmissionKind = 'upload' | 'archive';

export interface Reservation {
  kind: AdmissionKind;
  /** Upload: bytes to be stored (original + estimated derivatives). Archive: bytes to be served. */
  bytes: number;
}

export interface CurrentUsage {
  /** Bytes stored right now (originals + derivatives + archives). */
  storedBytes: number;
  /** Byte-seconds already accrued this period (from the ledger). */
  storageByteSecondsToDate: bigint;
  /** Delivery bytes already metered this period. */
  deliveryBytesToDate: number;
}

export interface FreeLimits {
  maxStorageBytes: number;
  maxDeliveryBytesPerMonth: number;
}

export type AdmissionDenialReason =
  'past_due' | 'account_canceled' | 'free_storage_cap' | 'free_delivery_cap' | 'spend_cap';

export type AdmissionDecision =
  | { allowed: true; projectedOverageMicroUsd: number; remainingCapMicroUsd: number | null }
  | {
      allowed: false;
      reason: AdmissionDenialReason;
      projectedOverageMicroUsd: number;
      remainingCapMicroUsd: number | null;
    };

export interface AdmissionInput {
  plan: PlanRates;
  account: BillingAccountState;
  now: Date;
  period: { start: Date; end: Date };
  currentUsage: CurrentUsage;
  /** Pending, not-yet-settled reservations (uploads in progress, archives being built). */
  reservations: readonly Reservation[];
  requested: Reservation;
  /** Overage cap in micro-USD; `null` falls back to the plan default (no cap if that is null too). */
  capMicroUsd: number | null;
  /** Hard caps for plans without overage billing. Defaults to the plan's own limits. */
  freeLimits?: FreeLimits;
  policy?: BillingPolicy;
}

/** The plan's hard limits, or `null` for plans that bill overage instead. */
export function freeLimitsForPlan(plan: PlanRates): FreeLimits | null {
  if (plan.maxStorageBytes === null || plan.maxDeliveryBytesPerMonth === null) return null;
  return {
    maxStorageBytes: plan.maxStorageBytes,
    maxDeliveryBytesPerMonth: plan.maxDeliveryBytesPerMonth,
  };
}

export function effectiveCapMicroUsd(plan: PlanRates, capMicroUsd: number | null): number | null {
  const cap = capMicroUsd ?? plan.defaultOverageCapMicroUsd;
  if (cap !== null) toNonNegativeBigInt(cap, 'capMicroUsd');
  return cap;
}

const sumBytes = (reservations: readonly Reservation[], kind: AdmissionKind): bigint =>
  reservations
    .filter((r) => r.kind === kind)
    .reduce((sum, r) => sum + toNonNegativeBigInt(r.bytes, 'reservation.bytes'), 0n);

export function checkAdmission(input: AdmissionInput): AdmissionDecision {
  const { plan, currentUsage, requested } = input;
  const policy = input.policy ?? BILLING_POLICY_V1;
  const cap = effectiveCapMicroUsd(plan, input.capMicroUsd);

  const all = [...input.reservations, requested];
  const storedNow = toNonNegativeBigInt(currentUsage.storedBytes, 'storedBytes');
  const deliveredNow = toNonNegativeBigInt(currentUsage.deliveryBytesToDate, 'deliveryBytesToDate');
  const projectedStored = storedNow + sumBytes(all, 'upload');
  const projectedDelivery = deliveredNow + sumBytes(all, 'archive');

  const nowMs = input.now.getTime();
  const endMs = input.period.end.getTime();
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(endMs)) {
    throw new BillingArithmeticError('invalid admission timestamps');
  }
  const remainingMs = BigInt(Math.max(0, endMs - nowMs));
  const projectedByteSeconds =
    toNonNegativeBigInt(currentUsage.storageByteSecondsToDate, 'storageByteSecondsToDate') +
    divCeil(projectedStored * remainingMs, 1000n);

  const projectedOverageMicroUsd = estimateOverageMicroUsd(
    { storageByteSeconds: projectedByteSeconds, deliveryBytes: projectedDelivery },
    plan,
    policy.secondsPerBillingMonth,
  );
  const remainingCapMicroUsd = cap === null ? null : Math.max(0, cap - projectedOverageMicroUsd);
  const deny = (reason: AdmissionDenialReason): AdmissionDecision => ({
    allowed: false,
    reason,
    projectedOverageMicroUsd,
    remainingCapMicroUsd,
  });

  const restrictions = deriveBillingRestrictions(input.account, input.now, policy);
  const kindAllowed =
    requested.kind === 'upload' ? restrictions.uploadsAllowed : restrictions.archivesAllowed;
  if (!kindAllowed) {
    return deny(restrictions.effectiveStatus === 'canceled' ? 'account_canceled' : 'past_due');
  }

  const limits = input.freeLimits ?? freeLimitsForPlan(plan);
  if (limits) {
    if (requested.kind === 'upload' && projectedStored > BigInt(limits.maxStorageBytes)) {
      return deny('free_storage_cap');
    }
    if (
      requested.kind === 'archive' &&
      projectedDelivery > BigInt(limits.maxDeliveryBytesPerMonth)
    ) {
      return deny('free_delivery_cap');
    }
  }

  if (cap !== null && projectedOverageMicroUsd > cap) return deny('spend_cap');

  return { allowed: true, projectedOverageMicroUsd, remainingCapMicroUsd };
}

export type GalleryCreationDecision =
  { allowed: true } | { allowed: false; reason: 'free_gallery_cap' };

/** FR-G07: Free accounts may hold `plan.maxActiveGalleries` non-deleted galleries. */
export function checkGalleryCreation(input: {
  plan: PlanRates;
  activeGalleryCount: number;
}): GalleryCreationDecision {
  toNonNegativeBigInt(input.activeGalleryCount, 'activeGalleryCount');
  const max = input.plan.maxActiveGalleries;
  if (max !== null && input.activeGalleryCount + 1 > max) {
    return { allowed: false, reason: 'free_gallery_cap' };
  }
  return { allowed: true };
}

/** Disclosed maximum overshoot above the cap: max(cap × bps / 10 000, min), rounded half up. */
export function spendCapToleranceMicroUsd(
  capMicroUsd: number,
  policy: BillingPolicy = BILLING_POLICY_V1,
): number {
  const cap = toNonNegativeBigInt(capMicroUsd, 'capMicroUsd');
  const proportional = (2n * cap * BigInt(policy.spendCapToleranceBps) + 10_000n) / 20_000n;
  const min = BigInt(policy.spendCapToleranceMinMicroUsd);
  return toSafeNumber(proportional > min ? proportional : min);
}

/** Reconciliation check (T31/T32): did the period's overage exceed cap + tolerance? */
export function exceedsCapTolerance(
  overageMicroUsd: number,
  capMicroUsd: number,
  policy: BillingPolicy = BILLING_POLICY_V1,
): boolean {
  return overageMicroUsd > capMicroUsd + spendCapToleranceMicroUsd(capMicroUsd, policy);
}

export type DeliveryDecision =
  | { allowed: true }
  | { allowed: false; reason: 'past_due' | 'account_canceled' | 'free_delivery_cap' | 'spend_cap' };

/**
 * Gateway/ledger safety cutoff for new billable delivery (PRD §9.4). Free pauses at the monthly
 * delivery cap; Pro pauses once the estimated overage has reached the cap. Transfers already in
 * flight may finish, which is what the disclosed tolerance covers.
 */
export function checkDeliveryAllowance(input: {
  plan: PlanRates;
  account: BillingAccountState;
  now: Date;
  usage: { storageByteSecondsToDate: bigint; deliveryBytesToDate: number };
  capMicroUsd: number | null;
  freeLimits?: FreeLimits;
  policy?: BillingPolicy;
}): DeliveryDecision {
  const policy = input.policy ?? BILLING_POLICY_V1;
  const restrictions = deriveBillingRestrictions(input.account, input.now, policy);
  if (!restrictions.publicDeliveryAllowed) {
    return {
      allowed: false,
      reason: restrictions.effectiveStatus === 'canceled' ? 'account_canceled' : 'past_due',
    };
  }
  const limits = input.freeLimits ?? freeLimitsForPlan(input.plan);
  if (limits && input.usage.deliveryBytesToDate >= limits.maxDeliveryBytesPerMonth) {
    return { allowed: false, reason: 'free_delivery_cap' };
  }
  const cap = effectiveCapMicroUsd(input.plan, input.capMicroUsd);
  if (cap !== null) {
    const overage = estimateOverageMicroUsd(
      {
        storageByteSeconds: input.usage.storageByteSecondsToDate,
        deliveryBytes: input.usage.deliveryBytesToDate,
      },
      input.plan,
      policy.secondsPerBillingMonth,
    );
    // A zero cap with zero overage still allows delivery inside the allowance.
    if (overage > 0 && overage >= cap) return { allowed: false, reason: 'spend_cap' };
  }
  return { allowed: true };
}

/**
 * Alert thresholds (percent of cap) newly crossed by moving from `prevSpendMicroUsd` to
 * `newSpendMicroUsd`, ascending. A threshold t is crossed when spend × 100 ≥ t × cap and spend
 * is positive (so a $0 cap alerts on the first billable micro-dollar, not at zero). Persist sent
 * alerts keyed by (account, period, threshold) for dedupe.
 */
export function alertThresholdsCrossed(
  prevSpendMicroUsd: number,
  newSpendMicroUsd: number,
  capMicroUsd: number,
  thresholdsPct: readonly number[] = BILLING_POLICY_V1.defaultAlertThresholdsPct,
): number[] {
  const prev = toNonNegativeBigInt(prevSpendMicroUsd, 'prevSpendMicroUsd');
  const next = toNonNegativeBigInt(newSpendMicroUsd, 'newSpendMicroUsd');
  const cap = toNonNegativeBigInt(capMicroUsd, 'capMicroUsd');
  const reached = (spend: bigint, pct: bigint): boolean => spend > 0n && spend * 100n >= pct * cap;
  return [...new Set(thresholdsPct)]
    .sort((a, b) => a - b)
    .filter((t) => {
      const pct = toNonNegativeBigInt(t, 'threshold');
      return reached(next, pct) && !reached(prev, pct);
    });
}
