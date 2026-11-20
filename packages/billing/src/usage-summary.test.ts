import { BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import {
  BillingArithmeticError,
  calendarMonthPeriod,
  currentBillingPeriod,
  percentOfLimit,
  summarizeUsage,
} from './index';

describe('billing period', () => {
  it('uses the UTC calendar month without a stored period', () => {
    const p = calendarMonthPeriod(new Date('2026-12-31T23:59:59.999Z'));
    expect(p.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(currentBillingPeriod(null, new Date('2026-02-10T00:00:00Z')).start.toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('prefers the account’s stored period when both ends are set', () => {
    const start = new Date('2026-11-05T00:00:00Z');
    const end = new Date('2026-12-05T00:00:00Z');
    const now = new Date('2026-11-09T00:00:00Z');
    expect(currentBillingPeriod({ billingPeriodStart: start, billingPeriodEnd: end }, now)).toEqual(
      {
        start,
        end,
      },
    );
    expect(
      currentBillingPeriod({ billingPeriodStart: start, billingPeriodEnd: null }, now).start,
    ).toEqual(new Date('2026-11-01T00:00:00Z'));
  });
});

describe('percentOfLimit', () => {
  it('rounds down, clamps and handles no/zero limits', () => {
    expect(percentOfLimit(0, BYTES_PER_GB)).toBe(0);
    expect(percentOfLimit(999_999_999, BYTES_PER_GB)).toBe(99);
    expect(percentOfLimit(BYTES_PER_GB, BYTES_PER_GB)).toBe(100);
    expect(percentOfLimit(5 * BYTES_PER_GB, BYTES_PER_GB)).toBe(100);
    expect(percentOfLimit(123, null)).toBeNull();
    expect(percentOfLimit(0, 0)).toBe(0);
    expect(percentOfLimit(1, 0)).toBe(100);
  });

  it('rejects non-integer or negative bytes', () => {
    expect(() => percentOfLimit(-1, 10)).toThrow(BillingArithmeticError);
    expect(() => percentOfLimit(1.5, 10)).toThrow(BillingArithmeticError);
  });
});

describe('summarizeUsage', () => {
  it('reports the Free storage limit and nothing about delivery (ADR-008)', () => {
    const s = summarizeUsage({ plan: RATE_CARD_V1.free, storedBytes: 250_000_000 });
    expect(s).toEqual({
      storage: {
        usedBytes: 250_000_000,
        limitBytes: BYTES_PER_GB,
        percentUsed: 25,
        tracked: true,
      },
    });
  });

  it('has no hard limits on Pro', () => {
    const s = summarizeUsage({ plan: RATE_CARD_V1.pro, storedBytes: 7 });
    expect(s.storage.limitBytes).toBeNull();
    expect(s.storage.percentUsed).toBeNull();
  });
});
