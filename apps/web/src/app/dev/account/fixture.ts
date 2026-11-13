import { BILLING_POLICY_V1, BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import { accountUsageSummarySchema, type AccountUsageSummary } from '@lumra/contracts';

/** `/account` billing states for the dev fixture page, screenshots and component tests. */
export const ACCOUNT_FIXTURE_STATES = [
  'free',
  'free_at_caps',
  'free_delivery_paused',
  'checkout_pending',
  'pro',
  'pro_canceling',
  'past_due',
  'restricted',
  'canceled',
  'unconfigured',
] as const;
export type AccountFixtureState = (typeof ACCOUNT_FIXTURE_STATES)[number];

const DAY = 86_400_000;

export function makeAccountFixture(
  state: AccountFixtureState,
  now = new Date('2026-11-13T12:00:00Z'),
): { summary: AccountUsageSummary; checkout: 'success' | null } {
  const { free, pro } = RATE_CARD_V1;
  const isPro = ['pro', 'pro_canceling', 'past_due', 'restricted'].includes(state);
  const plan = isPro ? pro : free;
  const periodStart = isPro ? new Date('2026-11-04T09:30:00Z') : new Date('2026-11-01T00:00:00Z');
  const periodEnd = isPro ? new Date('2026-12-04T09:30:00Z') : new Date('2026-12-01T00:00:00Z');
  const pastDueSince = new Date(now.getTime() - (state === 'restricted' ? 9 : 2) * DAY);
  const suspends = new Date(pastDueSince.getTime() + BILLING_POLICY_V1.pastDueGraceMs);
  const canceledAt = new Date(now.getTime() - 3 * DAY);

  const storedBytes =
    state === 'free_at_caps'
      ? 970_000_000
      : state === 'canceled'
        ? 4.2 * BYTES_PER_GB
        : isPro
          ? 12.4 * BYTES_PER_GB
          : 310_000_000;
  const deliveredBytes =
    state === 'free_delivery_paused'
      ? 3 * BYTES_PER_GB
      : isPro
        ? 7.8 * BYTES_PER_GB
        : 1.1 * BYTES_PER_GB;
  const pct = (used: number, limit: number | null) =>
    limit === null ? null : Math.min(100, Math.floor((used * 100) / limit));

  const status: AccountUsageSummary['billingStatus'] =
    state === 'past_due'
      ? 'past_due'
      : state === 'restricted'
        ? 'restricted'
        : state === 'canceled'
          ? 'canceled'
          : isPro
            ? 'active'
            : 'free';

  const summary: AccountUsageSummary = {
    email: 'ada@example.com',
    plan: isPro ? 'pro' : 'free',
    billingStatus: status,
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    storage: {
      usedBytes: Math.round(storedBytes),
      limitBytes: plan.maxStorageBytes,
      percentUsed: pct(storedBytes, plan.maxStorageBytes),
      tracked: true,
      itemCount: Math.round(storedBytes / 9_000_000),
    },
    delivery: {
      usedBytes: Math.round(deliveredBytes),
      limitBytes: plan.maxDeliveryBytesPerMonth,
      percentUsed: pct(deliveredBytes, plan.maxDeliveryBytesPerMonth),
      tracked: true,
    },
    billing: {
      paymentsEnabled: state !== 'unconfigured',
      hasCustomer: isPro || state === 'canceled',
      cancelAtPeriodEnd: state === 'pro_canceling',
      uploadsAllowed: !['past_due', 'restricted', 'canceled'].includes(state),
      publicDeliveryAllowed: !['restricted', 'canceled'].includes(state),
      deliverySuspendsAt:
        state === 'past_due' || state === 'restricted'
          ? suspends.toISOString()
          : state === 'canceled'
            ? canceledAt.toISOString()
            : null,
      retentionEndsAt:
        state === 'past_due' || state === 'restricted'
          ? new Date(
              suspends.getTime() + BILLING_POLICY_V1.retentionAfterSuspensionMs,
            ).toISOString()
          : state === 'canceled'
            ? new Date(
                canceledAt.getTime() + BILLING_POLICY_V1.retentionAfterSuspensionMs,
              ).toISOString()
            : null,
      deliveryPaused: state === 'free_delivery_paused' ? 'free_delivery_cap' : null,
      galleries: {
        active: state === 'canceled' ? 5 : state === 'free_at_caps' ? 2 : isPro ? 14 : 1,
        max: plan.maxActiveGalleries,
      },
    },
  };
  return {
    summary: accountUsageSummarySchema.parse(summary),
    checkout: state === 'checkout_pending' ? 'success' : null,
  };
}
