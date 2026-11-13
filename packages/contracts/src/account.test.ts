import { describe, expect, it } from 'vitest';
import { accountUsageSummarySchema } from './index';

describe('accountUsageSummarySchema', () => {
  const valid = {
    email: 'a@example.test',
    plan: 'free',
    billingStatus: 'free',
    period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
    storage: {
      usedBytes: 250_000_000,
      limitBytes: 1_000_000_000,
      percentUsed: 25,
      tracked: true,
      itemCount: 12,
    },
    delivery: { usedBytes: null, limitBytes: 3_000_000_000, percentUsed: null, tracked: false },
    billing: {
      paymentsEnabled: true,
      hasCustomer: false,
      cancelAtPeriodEnd: false,
      uploadsAllowed: true,
      publicDeliveryAllowed: true,
      deliverySuspendsAt: null,
      retentionEndsAt: null,
      deliveryPaused: null,
      galleries: { active: 1, max: 2 },
    },
  };

  it('accepts a summary with untracked delivery', () => {
    expect(accountUsageSummarySchema.parse(valid)).toEqual(valid);
  });

  it('rejects fractional bytes, out-of-range percentages and unknown plans', () => {
    const bad = (patch: object) => accountUsageSummarySchema.safeParse({ ...valid, ...patch });
    expect(bad({ storage: { ...valid.storage, usedBytes: 1.5 } }).success).toBe(false);
    expect(bad({ storage: { ...valid.storage, percentUsed: 101 } }).success).toBe(false);
    expect(bad({ plan: 'enterprise' }).success).toBe(false);
    expect(bad({ billing: { ...valid.billing, deliveryPaused: 'other' } }).success).toBe(false);
  });
});
