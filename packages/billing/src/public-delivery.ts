import { BILLING_POLICY_V1, type BillingPolicy } from '@lumra/config';
import { type BillingAccountState, deriveBillingRestrictions } from './account';

/**
 * Public gallery availability (PRD §9.4). Lumra does not meter, cap or bill delivery (ADR-008),
 * so the only reason recipients stop being served is the account's billing status: `past_due`
 * after its grace, `restricted` or `canceled` (`deriveBillingRestrictions`).
 */
export type PublicDeliveryState =
  { available: true } | { available: false; reason: 'billing_suspended' };

/**
 * Can recipients be served right now? Fails closed when the billing row violates its own
 * invariants (e.g. `past_due` without `past_due_since`). Used by the recipient page and the
 * worker's KV writer, so both always agree.
 */
export function publicDeliveryState(
  account: BillingAccountState | null,
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
  return { available: true };
}
