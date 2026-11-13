import { BILLING_POLICY_V1, type BillingPolicy } from '@lumra/config';
import { type BillingAccountState, deriveBillingRestrictions } from './account';
import { type DeliveryDecision } from './admission';

/**
 * Delivery safety cutoff state (PRD §9.4, T28/T32). `checkDeliveryAllowance` decides; the result
 * is persisted on `billing_accounts.delivery_paused_reason` so the media gateway (through the KV
 * access state) and the recipient page stop serving until the allowance is back: a new period,
 * a higher cap or an upgrade. Status-based suspensions (past due, canceled) are not "pauses":
 * they are derived from the status itself by `deriveBillingRestrictions`.
 */
export const DELIVERY_PAUSE_REASONS = ['free_delivery_cap', 'spend_cap'] as const;
export type DeliveryPauseReason = (typeof DELIVERY_PAUSE_REASONS)[number];

export function deliveryPauseFor(decision: DeliveryDecision): DeliveryPauseReason | null {
  if (decision.allowed) return null;
  return decision.reason === 'free_delivery_cap' || decision.reason === 'spend_cap'
    ? decision.reason
    : null;
}

export type PublicDeliveryState =
  { available: true } | { available: false; reason: DeliveryPauseReason | 'billing_suspended' };

/**
 * Can recipients be served right now? Fails closed when the billing row violates its own
 * invariants (e.g. `past_due` without `past_due_since`). Used by the recipient page and the
 * worker's KV writer, so both always agree.
 */
export function publicDeliveryState(
  account: (BillingAccountState & { deliveryPausedReason: DeliveryPauseReason | null }) | null,
  now: Date,
  policy: BillingPolicy = BILLING_POLICY_V1,
): PublicDeliveryState {
  if (!account) return { available: true };
  try {
    if (!deriveBillingRestrictions(account, now, policy).publicDeliveryAllowed) {
      return { available: false, reason: 'billing_suspended' };
    }
  } catch {
    return { available: false, reason: 'billing_suspended' };
  }
  if (account.deliveryPausedReason) {
    return { available: false, reason: account.deliveryPausedReason };
  }
  return { available: true };
}
