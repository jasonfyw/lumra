import type { PlanId, PlanRates } from '@lumra/config';
import { BILLING_POLICY_V1, type BillingPolicy } from '@lumra/config';
import {
  BILLING_ACCOUNT_TRANSITIONS,
  type BillingAccountStatus,
  assertBillingTransition,
  deriveBillingRestrictions,
} from './account';

/**
 * Subscription entitlements (T30/T33, PRD §9.5). Pure rules that turn a **confirmed** Stripe
 * subscription state (from a signature-verified webhook) into the persisted billing account:
 * status, plan, period and the timestamps the past-due policy hangs off. Redirect query strings
 * never reach this code. Structural input types keep this package free of the Stripe SDK.
 */

/** `Stripe.Subscription.Status` values (unknown future values are tolerated). */
export type StripeSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'
  | (string & {});

/**
 * Billing status a Stripe status entitles to, or `null` for "no change" (`incomplete`: the first
 * payment is still being confirmed, so nothing is granted and nothing is taken away).
 * `unpaid` (retries exhausted) stays `past_due`: the grace clock that started at the first
 * failure keeps running and `deriveBillingRestrictions` suspends delivery when it ends.
 * `paused` has no grace: delivery stops at once (`restricted`).
 */
export function billingStatusForStripe(
  status: StripeSubscriptionStatus,
): BillingAccountStatus | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused':
      return 'restricted';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

/** The part of a Stripe subscription the entitlement rules read. */
export interface SubscriptionSnapshot {
  subscriptionId: string;
  customerId: string;
  status: StripeSubscriptionStatus;
  /** Current period from the subscription items (API ≥ 2025-03); null if absent. */
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** `event.created`: orders deliveries, which Stripe does not guarantee. */
  eventCreated: Date;
}

/** The persisted billing account fields the rules read and write. */
export interface EntitlementState {
  status: BillingAccountStatus;
  planId: PlanId;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  pastDueSince: Date | null;
  restrictedSince: Date | null;
  canceledAt: Date | null;
  /** `event.created` of the last applied subscription event. */
  subscriptionEventAt: Date | null;
}

/** Transition notifications (PRD §9.4 "notify at transitions"); sent through the outbox. */
export type BillingNotice =
  | 'pro_activated'
  | 'payment_failed'
  | 'payment_recovered'
  | 'delivery_suspended'
  | 'subscription_ended';

export type EntitlementDecision =
  | {
      kind: 'ignore';
      reason: 'stale_event' | 'other_subscription' | 'incomplete' | 'not_entitled' | 'no_path';
    }
  | {
      kind: 'update';
      next: EntitlementState;
      /** Persisted statuses walked through, in order (each step is a legal transition). */
      path: BillingAccountStatus[];
      notices: BillingNotice[];
      /** True when public delivery or plan branding may have changed (re-sync gallery KV). */
      accessChanged: boolean;
    };

/** Shortest legal path from `from` to `to` through `BILLING_ACCOUNT_TRANSITIONS` (BFS). */
export function billingTransitionPath(
  from: BillingAccountStatus,
  to: BillingAccountStatus,
): BillingAccountStatus[] | null {
  if (from === to) return [];
  const previous = new Map<BillingAccountStatus, BillingAccountStatus>();
  const queue: BillingAccountStatus[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of BILLING_ACCOUNT_TRANSITIONS[current]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path: BillingAccountStatus[] = [to];
        let step = current;
        while (step !== from) {
          path.unshift(step);
          step = previous.get(step)!;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

const PAID: ReadonlySet<BillingAccountStatus> = new Set(['active', 'past_due', 'restricted']);
const live = (status: BillingAccountStatus) => PAID.has(status);

/**
 * Applies a subscription snapshot to the stored account.
 *
 * - Older events than the last applied one are ignored (`stale_event`), so out-of-order
 *   deliveries converge on the newest state; equal timestamps re-apply (idempotent).
 * - Events for a subscription other than the account's current one only matter when they grant
 *   access (a re-subscription); a stale old subscription ending is ignored.
 * - `canceled` falls through to `free` when the account already fits the Free caps
 *   (`fitsFreeCaps`); otherwise it stays `canceled` (uploads and delivery stopped, media kept
 *   for the retention window) until the owner trims it — see `sweepBillingAccount`.
 */
export function applySubscriptionSnapshot(
  current: EntitlementState,
  snapshot: SubscriptionSnapshot,
  options: { fitsFreeCaps: boolean },
): EntitlementDecision {
  if (
    current.subscriptionEventAt &&
    snapshot.eventCreated.getTime() < current.subscriptionEventAt.getTime()
  ) {
    return { kind: 'ignore', reason: 'stale_event' };
  }
  const target = billingStatusForStripe(snapshot.status);
  if (target === null) return { kind: 'ignore', reason: 'incomplete' };

  const isCurrent =
    current.stripeSubscriptionId === null ||
    current.stripeSubscriptionId === snapshot.subscriptionId;
  // Another subscription matters only when it grants access the current one doesn't (a
  // re-subscription); an old subscription ending later must not touch the new one.
  if (!isCurrent && !(live(target) && !live(current.status))) {
    return { kind: 'ignore', reason: 'other_subscription' };
  }
  // A subscription that never granted access (e.g. `incomplete_expired`) changes nothing.
  if (target === 'canceled' && !live(current.status)) {
    return { kind: 'ignore', reason: 'not_entitled' };
  }

  // Stripe still reports `past_due`/`unpaid` after our grace ended: stay `restricted` (the sweep
  // persisted it); only a payment (active) or cancellation moves the account on.
  const finalStatus: BillingAccountStatus =
    target === 'canceled' && options.fitsFreeCaps
      ? 'free'
      : target === 'past_due' && current.status === 'restricted'
        ? 'restricted'
        : target;
  const path = billingTransitionPath(current.status, finalStatus);
  if (path === null) return { kind: 'ignore', reason: 'no_path' };
  let step = current.status;
  for (const next of path) {
    assertBillingTransition(step, next);
    step = next;
  }

  const at = snapshot.eventCreated;
  const paid = live(finalStatus);
  const next: EntitlementState = {
    status: finalStatus,
    planId: paid ? 'pro' : 'free',
    stripeSubscriptionId: snapshot.subscriptionId,
    stripeSubscriptionStatus: snapshot.status,
    cancelAtPeriodEnd: paid ? snapshot.cancelAtPeriodEnd : false,
    billingPeriodStart: paid ? snapshot.periodStart : null,
    billingPeriodEnd: paid ? snapshot.periodEnd : null,
    pastDueSince:
      finalStatus === 'past_due' || finalStatus === 'restricted'
        ? (current.pastDueSince ?? at)
        : null,
    restrictedSince: finalStatus === 'restricted' ? (current.restrictedSince ?? at) : null,
    canceledAt: finalStatus === 'canceled' ? (current.canceledAt ?? at) : null,
    subscriptionEventAt: at,
  };

  const notices: BillingNotice[] = [];
  const was = current.status;
  if (finalStatus !== was) {
    if (finalStatus === 'active') {
      notices.push(
        was === 'past_due' || was === 'restricted' ? 'payment_recovered' : 'pro_activated',
      );
    } else if (finalStatus === 'past_due') {
      notices.push('payment_failed');
    } else if (finalStatus === 'restricted') {
      notices.push('delivery_suspended');
    } else if (live(was)) {
      notices.push('subscription_ended');
    }
  }

  return {
    kind: 'update',
    next,
    path,
    notices,
    accessChanged: finalStatus !== was || next.planId !== current.planId,
  };
}

// ---------------------------------------------------------------------------------------------
// time-based maintenance (hourly sweep, T33)
// ---------------------------------------------------------------------------------------------

/** Does the account's current footprint fit the Free plan's hard caps? */
export function fitsFreeCaps(
  free: Pick<PlanRates, 'maxActiveGalleries' | 'maxStorageBytes'>,
  usage: { activeGalleries: number; storedBytes: number },
): boolean {
  if (free.maxActiveGalleries !== null && usage.activeGalleries > free.maxActiveGalleries) {
    return false;
  }
  if (free.maxStorageBytes !== null && usage.storedBytes > free.maxStorageBytes) return false;
  return true;
}

export type SweepDecision =
  | { kind: 'none' }
  | {
      kind: 'update';
      status: BillingAccountStatus;
      restrictedSince: Date | null;
      canceledAt: Date | null;
      notices: BillingNotice[];
    };

/**
 * Persists the time-based consequences `deriveBillingRestrictions` already enforces, so status,
 * banners and notifications follow policy even when no webhook arrives:
 * - `past_due` whose grace has elapsed → `restricted` (stamped at the grace end, not "now");
 * - `canceled` that now fits the Free caps → `free` (the owner trimmed their galleries).
 */
export function sweepBillingAccount(
  account: {
    status: BillingAccountStatus;
    pastDueSince: Date | null;
    restrictedSince: Date | null;
    canceledAt: Date | null;
  },
  now: Date,
  options: { fitsFreeCaps: boolean; policy?: BillingPolicy },
): SweepDecision {
  const policy = options.policy ?? BILLING_POLICY_V1;
  if (account.status === 'past_due' && account.pastDueSince) {
    const restrictions = deriveBillingRestrictions(account, now, policy);
    if (restrictions.effectiveStatus === 'restricted') {
      assertBillingTransition('past_due', 'restricted');
      return {
        kind: 'update',
        status: 'restricted',
        restrictedSince: restrictions.deliverySuspendsAt,
        canceledAt: null,
        notices: ['delivery_suspended'],
      };
    }
  }
  if (account.status === 'canceled' && options.fitsFreeCaps) {
    assertBillingTransition('canceled', 'free');
    return { kind: 'update', status: 'free', restrictedSince: null, canceledAt: null, notices: [] };
  }
  return { kind: 'none' };
}
