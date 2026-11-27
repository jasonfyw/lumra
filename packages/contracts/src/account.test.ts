import { describe, expect, it } from 'vitest';
import { accountUsageSummarySchema, updateAccountRequestSchema } from './index';

describe('accountUsageSummarySchema', () => {
  const valid = {
    email: 'a@example.test',
    name: null,
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
    billing: {
      paymentsEnabled: true,
      hasCustomer: false,
      cancelAtPeriodEnd: false,
      uploadsAllowed: true,
      publicDeliveryAllowed: true,
      deliverySuspendsAt: null,
      retentionEndsAt: null,
      galleries: { active: 1, max: 2 },
    },
    spend: null,
    invoices: [],
  };

  it('accepts a storage-only summary', () => {
    expect(accountUsageSummarySchema.parse(valid)).toEqual(valid);
  });

  it('rejects fractional bytes, out-of-range percentages and unknown plans', () => {
    const bad = (patch: object) => accountUsageSummarySchema.safeParse({ ...valid, ...patch });
    expect(bad({ storage: { ...valid.storage, usedBytes: 1.5 } }).success).toBe(false);
    expect(bad({ storage: { ...valid.storage, percentUsed: 101 } }).success).toBe(false);
    expect(bad({ plan: 'enterprise' }).success).toBe(false);
    expect(bad({ billing: { ...valid.billing, uploadsAllowed: 'yes' } }).success).toBe(false);
  });
});

describe('updateAccountRequestSchema (display name)', () => {
  const parse = (name: unknown) => updateAccountRequestSchema.safeParse({ name });

  it('trims the name', () => {
    expect(parse('  Ada Lovelace \n')).toEqual({ success: true, data: { name: 'Ada Lovelace' } });
  });

  it('clears to null on an empty or whitespace-only string', () => {
    expect(parse('')).toEqual({ success: true, data: { name: null } });
    expect(parse('   \t')).toEqual({ success: true, data: { name: null } });
  });

  it('allows exactly 80 characters after trimming and rejects 81', () => {
    expect(parse(` ${'a'.repeat(80)} `).success).toBe(true);
    expect(parse('a'.repeat(81)).success).toBe(false);
  });

  it('rejects non-strings, a missing name and unknown keys', () => {
    expect(parse(null).success).toBe(false);
    expect(parse(5).success).toBe(false);
    expect(updateAccountRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAccountRequestSchema.safeParse({ name: 'Ada', email: 'x@y.z' }).success).toBe(
      false,
    );
  });
});
