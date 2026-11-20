import { BILLING_POLICY_V1, BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BILLING_ACCOUNT_STATUSES,
  BILLING_ACCOUNT_TRANSITIONS,
  applySubscriptionSnapshot,
  billingStatusForStripe,
  billingTransitionPath,
  evaluateBillingSafeguards,
  fitsFreeCaps,
  planStorageAccrual,
  publicDeliveryState,
  sweepBillingAccount,
  type EntitlementState,
  type SafeguardContext,
  type SafeguardStore,
  type SubscriptionSnapshot,
} from './index';

const DAY = 86_400_000;
const t0 = new Date('2026-11-13T10:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);

const freeAccount: EntitlementState = {
  status: 'free',
  planId: 'free',
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: null,
  cancelAtPeriodEnd: false,
  billingPeriodStart: null,
  billingPeriodEnd: null,
  pastDueSince: null,
  restrictedSince: null,
  canceledAt: null,
  subscriptionEventAt: null,
};

const snap = (
  status: string,
  eventCreated: Date,
  extra: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot => ({
  subscriptionId: 'sub_1',
  customerId: 'cus_1',
  status,
  periodStart: new Date('2026-11-13T10:00:00Z'),
  periodEnd: new Date('2026-12-13T10:00:00Z'),
  cancelAtPeriodEnd: false,
  eventCreated,
  ...extra,
});

/** Applies a sequence of snapshots, as the webhook would, returning the final state. */
function run(
  start: EntitlementState,
  snapshots: SubscriptionSnapshot[],
  fits = true,
): { state: EntitlementState; notices: string[] } {
  let state = start;
  const notices: string[] = [];
  for (const s of snapshots) {
    const d = applySubscriptionSnapshot(state, s, { fitsFreeCaps: fits });
    if (d.kind === 'update') {
      state = d.next;
      notices.push(...d.notices);
    }
  }
  return { state, notices };
}

describe('billingStatusForStripe', () => {
  it('maps every Stripe status', () => {
    expect(billingStatusForStripe('active')).toBe('active');
    expect(billingStatusForStripe('trialing')).toBe('active');
    expect(billingStatusForStripe('past_due')).toBe('past_due');
    expect(billingStatusForStripe('unpaid')).toBe('past_due');
    expect(billingStatusForStripe('paused')).toBe('restricted');
    expect(billingStatusForStripe('canceled')).toBe('canceled');
    expect(billingStatusForStripe('incomplete_expired')).toBe('canceled');
    expect(billingStatusForStripe('incomplete')).toBeNull();
    expect(billingStatusForStripe('something_new')).toBeNull();
  });
});

describe('billingTransitionPath', () => {
  it('finds the shortest legal path or null', () => {
    expect(billingTransitionPath('free', 'active')).toEqual(['active']);
    expect(billingTransitionPath('active', 'restricted')).toEqual(['past_due', 'restricted']);
    expect(billingTransitionPath('active', 'free')).toEqual(['canceled', 'free']);
    expect(billingTransitionPath('free', 'free')).toEqual([]);
    expect(billingTransitionPath('canceled', 'past_due')).toEqual(['active', 'past_due']);
  });

  it('every path step is in the transition table (exhaustive)', () => {
    for (const from of BILLING_ACCOUNT_STATUSES) {
      for (const to of BILLING_ACCOUNT_STATUSES) {
        const path = billingTransitionPath(from, to);
        if (path === null) continue;
        let step = from;
        for (const next of path) {
          expect(BILLING_ACCOUNT_TRANSITIONS[step]).toContain(next);
          step = next;
        }
        expect(step).toBe(to);
      }
    }
  });
});

describe('applySubscriptionSnapshot (T30)', () => {
  it('activates Pro exactly once across created(incomplete) → updated(active) → replay', () => {
    const { state, notices } = run(freeAccount, [
      snap('incomplete', at(0)),
      snap('active', at(0.001)),
      snap('active', at(0.001)),
      snap('active', at(0.002)),
    ]);
    expect(state.status).toBe('active');
    expect(state.planId).toBe('pro');
    expect(state.billingPeriodStart).toEqual(new Date('2026-11-13T10:00:00Z'));
    expect(notices).toEqual(['pro_activated']);
  });

  it('ignores incomplete subscriptions (no entitlement before payment confirms)', () => {
    const d = applySubscriptionSnapshot(freeAccount, snap('incomplete', at(0)), {
      fitsFreeCaps: true,
    });
    expect(d).toEqual({ kind: 'ignore', reason: 'incomplete' });
  });

  it('ignores stale (older) events so out-of-order delivery converges', () => {
    const { state } = run(freeAccount, [
      snap('active', at(0)),
      snap('past_due', at(2)),
      snap('active', at(1)), // older than the past_due event: dropped
    ]);
    expect(state.status).toBe('past_due');
    expect(state.pastDueSince).toEqual(at(2));
  });

  it('past_due keeps its grace clock; recovery clears it and notifies', () => {
    const { state, notices } = run(freeAccount, [
      snap('active', at(0)),
      snap('past_due', at(1)),
      snap('unpaid', at(3)),
      snap('active', at(4)),
    ]);
    expect(state.status).toBe('active');
    expect(state.pastDueSince).toBeNull();
    expect(notices).toEqual(['pro_activated', 'payment_failed', 'payment_recovered']);

    const stuck = run(freeAccount, [
      snap('active', at(0)),
      snap('past_due', at(1)),
      snap('unpaid', at(3)),
    ]);
    expect(stuck.state.pastDueSince).toEqual(at(1));
  });

  it('cancellation falls back to free when the account fits the Free caps, else canceled', () => {
    const active = run(freeAccount, [snap('active', at(0))]).state;
    const fits = applySubscriptionSnapshot(active, snap('canceled', at(5)), { fitsFreeCaps: true });
    expect(fits.kind === 'update' && fits.next).toMatchObject({
      status: 'free',
      planId: 'free',
      billingPeriodStart: null,
      canceledAt: null,
    });
    expect(fits.kind === 'update' && fits.path).toEqual(['canceled', 'free']);
    const over = applySubscriptionSnapshot(active, snap('canceled', at(5)), {
      fitsFreeCaps: false,
    });
    expect(over.kind === 'update' && over.next).toMatchObject({
      status: 'canceled',
      planId: 'free',
      canceledAt: at(5),
    });
    expect(over.kind === 'update' && over.notices).toEqual(['subscription_ended']);
  });

  it('cancel at period end keeps Pro and records the flag', () => {
    const { state } = run(freeAccount, [
      snap('active', at(0)),
      snap('active', at(1), { cancelAtPeriodEnd: true }),
    ]);
    expect(state).toMatchObject({ status: 'active', planId: 'pro', cancelAtPeriodEnd: true });
  });

  it('a never-entitled subscription expiring changes nothing', () => {
    const d = applySubscriptionSnapshot(freeAccount, snap('incomplete_expired', at(1)), {
      fitsFreeCaps: true,
    });
    expect(d).toEqual({ kind: 'ignore', reason: 'not_entitled' });
  });

  it('an old subscription ending never touches a newer live one; a re-subscription is adopted', () => {
    const active = run(freeAccount, [snap('active', at(0), { subscriptionId: 'sub_new' })]).state;
    expect(
      applySubscriptionSnapshot(active, snap('canceled', at(1), { subscriptionId: 'sub_old' }), {
        fitsFreeCaps: true,
      }),
    ).toEqual({ kind: 'ignore', reason: 'other_subscription' });

    const canceled = run(
      freeAccount,
      [snap('active', at(0)), snap('canceled', at(1))],
      false,
    ).state;
    const again = applySubscriptionSnapshot(
      canceled,
      snap('active', at(2), { subscriptionId: 'sub_2' }),
      { fitsFreeCaps: false },
    );
    expect(again.kind === 'update' && again.next).toMatchObject({
      status: 'active',
      stripeSubscriptionId: 'sub_2',
      canceledAt: null,
    });
  });

  it('a restricted account (grace ended) stays restricted while Stripe still says unpaid', () => {
    const restricted: EntitlementState = {
      ...run(freeAccount, [snap('active', at(0)), snap('past_due', at(1))]).state,
      status: 'restricted',
      restrictedSince: at(8),
    };
    const d = applySubscriptionSnapshot(restricted, snap('unpaid', at(9)), { fitsFreeCaps: true });
    expect(d.kind === 'update' && d.next).toMatchObject({
      status: 'restricted',
      pastDueSince: at(1),
      restrictedSince: at(8),
    });
    expect(d.kind === 'update' && d.notices).toEqual([]);
  });

  it('paused subscriptions restrict delivery at once', () => {
    const { state, notices } = run(freeAccount, [snap('active', at(0)), snap('paused', at(1))]);
    expect(state).toMatchObject({
      status: 'restricted',
      restrictedSince: at(1),
      pastDueSince: at(1),
    });
    expect(notices).toEqual(['pro_activated', 'delivery_suspended']);
  });

  it('property: any snapshot sequence keeps the timestamp invariants', () => {
    const statuses = fc.constantFrom(
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'paused',
      'canceled',
      'incomplete',
      'incomplete_expired',
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(statuses, fc.integer({ min: 0, max: 60 }), fc.boolean()), {
          maxLength: 12,
        }),
        (steps) => {
          let state = freeAccount;
          for (const [status, day, fits] of steps) {
            const d = applySubscriptionSnapshot(state, snap(status, at(day)), {
              fitsFreeCaps: fits,
            });
            if (d.kind === 'update') state = d.next;
            // The DB CHECK billing_accounts_status_timestamps must always hold.
            if (state.status === 'past_due') expect(state.pastDueSince).not.toBeNull();
            if (state.status === 'restricted') expect(state.restrictedSince).not.toBeNull();
            if (state.status === 'canceled') expect(state.canceledAt).not.toBeNull();
            expect(state.planId).toBe(
              ['active', 'past_due', 'restricted'].includes(state.status) ? 'pro' : 'free',
            );
          }
        },
      ),
    );
  });
});

describe('sweepBillingAccount (T33 time travel)', () => {
  const pastDue = {
    status: 'past_due' as const,
    pastDueSince: t0,
    restrictedSince: null,
    canceledAt: null,
  };

  it('keeps past_due through the 7-day grace, then restricts at the grace end', () => {
    expect(sweepBillingAccount(pastDue, at(6.99), { fitsFreeCaps: true })).toEqual({
      kind: 'none',
    });
    const d = sweepBillingAccount(pastDue, at(7.5), { fitsFreeCaps: true });
    expect(d).toEqual({
      kind: 'update',
      status: 'restricted',
      restrictedSince: new Date(t0.getTime() + BILLING_POLICY_V1.pastDueGraceMs),
      canceledAt: null,
      notices: ['delivery_suspended'],
    });
  });

  it('canceled moves to free only once the account fits the Free caps', () => {
    const canceled = {
      status: 'canceled' as const,
      pastDueSince: null,
      restrictedSince: null,
      canceledAt: t0,
    };
    expect(sweepBillingAccount(canceled, at(1), { fitsFreeCaps: false })).toEqual({ kind: 'none' });
    expect(sweepBillingAccount(canceled, at(1), { fitsFreeCaps: true })).toMatchObject({
      kind: 'update',
      status: 'free',
    });
  });

  it('fitsFreeCaps checks galleries and stored bytes', () => {
    const free = RATE_CARD_V1.free;
    expect(fitsFreeCaps(free, { activeGalleries: 2, storedBytes: BYTES_PER_GB })).toBe(true);
    expect(fitsFreeCaps(free, { activeGalleries: 3, storedBytes: 0 })).toBe(false);
    expect(fitsFreeCaps(free, { activeGalleries: 0, storedBytes: BYTES_PER_GB + 1 })).toBe(false);
  });
});

describe('public delivery and spend alerts (ADR-008: no delivery cutoff)', () => {
  const free = RATE_CARD_V1.free;
  const pro = RATE_CARD_V1.pro;
  const ok = {
    status: 'free' as const,
    pastDueSince: null,
    restrictedSince: null,
    canceledAt: null,
  };

  it('publicDeliveryState depends on billing status only, failing closed', () => {
    expect(publicDeliveryState(null, t0)).toEqual({ available: true });
    expect(publicDeliveryState(ok, t0)).toEqual({ available: true });
    expect(publicDeliveryState({ ...ok, status: 'active' }, t0)).toEqual({ available: true });
    expect(publicDeliveryState({ ...ok, status: 'past_due' }, t0)).toEqual({
      available: false,
      reason: 'billing_suspended',
    });
    expect(publicDeliveryState({ ...ok, status: 'past_due', pastDueSince: at(-1) }, t0)).toEqual({
      available: true,
    });
    expect(publicDeliveryState({ ...ok, status: 'past_due', pastDueSince: at(-8) }, t0)).toEqual({
      available: false,
      reason: 'billing_suspended',
    });
    expect(publicDeliveryState({ ...ok, status: 'canceled', canceledAt: at(-1) }, t0)).toEqual({
      available: false,
      reason: 'billing_suspended',
    });
  });

  it('evaluateBillingSafeguards only records storage spend alerts', async () => {
    const gbMonth = BigInt(BYTES_PER_GB) * BigInt(BILLING_POLICY_V1.secondsPerBillingMonth);
    const ctx = (over: Partial<SafeguardContext>): SafeguardContext => ({
      accountId: 'a',
      plan: free,
      spendCapMicroUsd: null,
      warningThresholdsPct: [50, 80, 100],
      period: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') },
      usage: { storageByteSecondsToDate: 0n },
      alertsSent: [],
      ...over,
    });
    const calls: unknown[][] = [];
    const store: SafeguardStore = {
      safeguardContexts: async () => [
        ctx({ accountId: 'free', usage: { storageByteSecondsToDate: 500n * gbMonth } }),
        // 20 GB-month included + 100 × $0.10 = $10.00 = the default cap.
        ctx({ accountId: 'pro', plan: pro, usage: { storageByteSecondsToDate: 120n * gbMonth } }),
      ],
      recordSpendAlerts: async (...args) => {
        calls.push(args);
        return args[2];
      },
    };
    const result = await evaluateBillingSafeguards(['free', 'pro'], {
      store,
      now: t0,
      traceId: 't',
    });
    expect(result).toEqual({ evaluated: 2, alerts: 3 });
    expect(calls).toEqual([
      [
        'pro',
        new Date('2026-11-01T00:00:00Z'),
        [50, 80, 100],
        { spendMicroUsd: 10_000_000, capMicroUsd: 10_000_000, traceId: 't' },
      ],
    ]);
  });
});

describe('Free can never create a positive overage ledger entry (T28 property)', () => {
  const free = RATE_CARD_V1.free;
  const accountId = '11111111-1111-4111-8111-111111111111';

  it('storage accrual rows on Free always carry zero estimated cost', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        fc.integer({ min: 1, max: 90 * 24 }),
        fc.bigInt({ min: 0n, max: 10n ** 19n }),
        (storedBytes, hours, toDate) => {
          const accrual = planStorageAccrual({
            accountId,
            account: null,
            plan: free,
            cursor: { accruedThrough: t0, storedBytes },
            storedBytesNow: storedBytes,
            windowEnd: new Date(t0.getTime() + hours * 3_600_000),
            byteSecondsToDate: toDate,
          });
          for (const e of accrual?.entries ?? []) expect(e.estimatedCostMicroUsd).toBe(0);
        },
      ),
    );
  });
});
