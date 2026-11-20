import { BYTES_PER_GB, RATE_CARD, RATE_CARD_V1 } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { USAGE_METRICS, sumLedger } from './ledger';
import { METERED_ACTIONS, billingPeriodAt, planStorageAccrual } from './metering';
import { rateInvoice } from './rating';
import { storageGbMonthMicroUnits } from './units';

const pro = RATE_CARD_V1.pro;
const free = RATE_CARD_V1.free;
const acct = '11111111-1111-4111-8111-111111111111';
const HOUR = 3_600_000;
const GB = BYTES_PER_GB;

describe('billingPeriodAt', () => {
  it('uses the stored period when it contains the instant', () => {
    const account = {
      billingPeriodStart: new Date('2026-11-15T00:00:00Z'),
      billingPeriodEnd: new Date('2026-12-15T00:00:00Z'),
    };
    expect(billingPeriodAt(account, new Date('2026-12-01T00:00:00Z')).start).toEqual(
      account.billingPeriodStart,
    );
  });

  it('falls back to the UTC calendar month outside a stored period or without one', () => {
    const stale = {
      billingPeriodStart: new Date('2026-09-15T00:00:00Z'),
      billingPeriodEnd: new Date('2026-10-15T00:00:00Z'),
    };
    const at = new Date('2026-11-09T12:00:00Z');
    for (const account of [stale, null, { billingPeriodStart: null, billingPeriodEnd: null }]) {
      expect(billingPeriodAt(account, at)).toEqual({
        start: new Date('2026-11-01T00:00:00Z'),
        end: new Date('2026-12-01T00:00:00Z'),
      });
    }
  });
});

describe('planStorageAccrual', () => {
  const base = {
    accountId: acct,
    account: null,
    plan: pro,
    byteSecondsToDate: 0n,
  };

  it('initialises the cursor on the first run without accruing anything', () => {
    const windowEnd = new Date('2026-11-09T10:00:00Z');
    const result = planStorageAccrual({
      ...base,
      cursor: null,
      storedBytesNow: 5 * GB,
      windowEnd,
    });
    expect(result).toEqual({
      entries: [],
      nextCursor: { accruedThrough: windowEnd, storedBytes: 5 * GB },
    });
  });

  it('holds the previous sample over the window (left Riemann) and advances the cursor', () => {
    const start = new Date('2026-11-09T10:00:00Z');
    const end = new Date(start.getTime() + HOUR);
    const result = planStorageAccrual({
      ...base,
      cursor: { accruedThrough: start, storedBytes: 2 * GB },
      storedBytesNow: 7 * GB,
      windowEnd: end,
    })!;
    expect(result.entries).toHaveLength(1);
    const [row] = result.entries;
    expect(row!.metric).toBe('storage_byte_seconds');
    expect(row!.unit).toBe('byte_second');
    expect(row!.quantity).toBe(2n * BigInt(GB) * 3600n);
    expect(row!.sourceId).toBe(`${acct}:${start.toISOString()}/${end.toISOString()}`);
    expect(row!.periodStart).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(row!.eventTime).toEqual(end);
    expect(row!.rateVersion).toBe(1);
    expect(result.nextCursor).toEqual({ accruedThrough: end, storedBytes: 7 * GB });
  });

  it('is deterministic: the same window yields byte-identical rows (ledger UNIQUE dedupes)', () => {
    const input = {
      ...base,
      cursor: { accruedThrough: new Date('2026-11-09T10:00:00Z'), storedBytes: 123_456_789 },
      storedBytesNow: 1,
      windowEnd: new Date('2026-11-09T11:00:00Z'),
    };
    expect(planStorageAccrual(input)).toEqual(planStorageAccrual(input));
  });

  it('splits a window at the billing-period boundary; each row lands in one period', () => {
    const result = planStorageAccrual({
      ...base,
      cursor: { accruedThrough: new Date('2026-11-30T23:00:00Z'), storedBytes: GB },
      storedBytesNow: GB,
      windowEnd: new Date('2026-12-01T02:00:00Z'),
    })!;
    expect(result.entries.map((e) => [e.periodStart.toISOString(), e.quantity])).toEqual([
      ['2026-11-01T00:00:00.000Z', BigInt(GB) * 3600n],
      ['2026-12-01T00:00:00.000Z', BigInt(GB) * 7200n],
    ]);
  });

  it('stops a calendar-month segment where a stored subscription period begins', () => {
    const account = {
      billingPeriodStart: new Date('2026-11-15T12:00:00Z'),
      billingPeriodEnd: new Date('2026-12-15T12:00:00Z'),
    };
    const result = planStorageAccrual({
      ...base,
      account,
      cursor: { accruedThrough: new Date('2026-11-15T11:00:00Z'), storedBytes: GB },
      storedBytesNow: GB,
      windowEnd: new Date('2026-11-15T13:00:00Z'),
    })!;
    expect(result.entries.map((e) => e.periodStart.toISOString())).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-15T12:00:00.000Z',
    ]);
  });

  it('writes no row for zero storage but still advances; a stale run is a no-op', () => {
    const cursor = { accruedThrough: new Date('2026-11-09T10:00:00Z'), storedBytes: 0 };
    const result = planStorageAccrual({
      ...base,
      cursor,
      storedBytesNow: 0,
      windowEnd: new Date('2026-11-09T11:00:00Z'),
    })!;
    expect(result.entries).toEqual([]);
    expect(result.nextCursor.accruedThrough).toEqual(new Date('2026-11-09T11:00:00Z'));
    expect(
      planStorageAccrual({ ...base, cursor, storedBytesNow: 0, windowEnd: cursor.accruedThrough }),
    ).toBeNull();
  });

  it('estimates marginal cost: zero inside the allowance, rate × overage beyond it', () => {
    const month = 30 * 86_400;
    const included = 20n * BigInt(GB) * BigInt(month); // 20 GB-month
    // Already at the allowance; one more GB held for a full 30-day month = 1 GB-month = $0.10.
    const start = new Date('2026-11-01T00:00:00Z');
    const result = planStorageAccrual({
      ...base,
      byteSecondsToDate: included,
      cursor: { accruedThrough: start, storedBytes: GB },
      storedBytesNow: GB,
      windowEnd: new Date(start.getTime() + month * 1000),
    })!;
    expect(result.entries[0]!.estimatedCostMicroUsd).toBe(100_000);
    const freeResult = planStorageAccrual({
      ...base,
      plan: free,
      byteSecondsToDate: included,
      cursor: { accruedThrough: start, storedBytes: GB },
      storedBytesNow: GB,
      windowEnd: new Date(start.getTime() + month * 1000),
    })!;
    expect(freeResult.entries[0]!.estimatedCostMicroUsd).toBe(0);
  });

  it('refuses an unbounded window', () => {
    expect(() =>
      planStorageAccrual({
        ...base,
        cursor: { accruedThrough: new Date('2020-01-01T00:00:00Z'), storedBytes: 1 },
        storedBytesNow: 1,
        windowEnd: new Date('2026-11-01T00:00:00Z'),
      }),
    ).toThrow(/too long/);
  });
});

describe('ledger coverage', () => {
  it('every usage metric has a metered-action producer; storage is the only one (ADR-008)', () => {
    expect(Object.keys(METERED_ACTIONS).sort()).toEqual([...USAGE_METRICS].sort());
    expect([...USAGE_METRICS]).toEqual(['storage_byte_seconds']);
  });

  it('metered rows for the PRD §9.3 example rate to exactly $3.00', () => {
    // 30 GB stored for a whole 30-day month, accrued hourly: $2.00 + (30 − 20) × $0.10.
    const month = 30 * 24;
    const start = new Date('2026-11-01T00:00:00Z');
    let cursor = { accruedThrough: start, storedBytes: 30 * GB };
    const rows = [];
    let toDate = 0n;
    for (let h = 1; h <= month; h++) {
      const result = planStorageAccrual({
        accountId: acct,
        account: null,
        plan: pro,
        cursor,
        storedBytesNow: 30 * GB,
        windowEnd: new Date(start.getTime() + h * HOUR),
        byteSecondsToDate: toDate,
      })!;
      rows.push(...result.entries);
      toDate += result.entries.reduce((s, e) => s + e.quantity, 0n);
      cursor = result.nextCursor;
    }
    const totals = sumLedger(rows);
    const invoice = rateInvoice({
      plan: pro,
      rateVersion: 1,
      storageGbMonthMicro: storageGbMonthMicroUnits(totals.storage_byte_seconds),
    });
    expect(invoice.totalMicroUsd).toBe(3_000_000);
    expect(invoice.totalCents).toBe(300);
    // Row-level estimates add up to the same overage (no hidden rounding drift).
    expect(rows.reduce((s, r) => s + r.estimatedCostMicroUsd, 0)).toBe(1_000_000);
  });

  it('pins each row to the plan version in force when it accrues (rate v1 → v2 mid-period)', () => {
    // 30 GB for the whole month; the price changes after day 25 (overage starts on day 20). v1 rows keep
    // rating_version 1 ($0.10); later rows carry 2 ($0.05). The period is rated as one total at the
    // newest version (what Stripe bills after the item moves to the v2 price): $2.00 + 10 × $0.05.
    const hours = 30 * 24;
    const start = new Date('2026-11-01T00:00:00Z');
    let cursor = { accruedThrough: start, storedBytes: 30 * GB };
    const rows = [];
    let toDate = 0n;
    for (let h = 1; h <= hours; h++) {
      const plan = h <= 25 * 24 ? RATE_CARD_V1.pro : RATE_CARD.pro;
      const result = planStorageAccrual({
        accountId: acct,
        account: null,
        plan,
        cursor,
        storedBytesNow: 30 * GB,
        windowEnd: new Date(start.getTime() + h * HOUR),
        byteSecondsToDate: toDate,
      })!;
      rows.push(...result.entries);
      toDate += result.entries.reduce((s, e) => s + e.quantity, 0n);
      cursor = result.nextCursor;
    }
    expect(new Set(rows.map((r) => r.rateVersion))).toEqual(new Set([1, 2]));
    expect(rows[0]!.rateVersion).toBe(1);
    expect(rows.at(-1)!.rateVersion).toBe(2);
    const newest = Math.max(...rows.map((r) => r.rateVersion));
    const totals = sumLedger(rows);
    const invoice = rateInvoice({
      plan: RATE_CARD.pro,
      rateVersion: newest,
      storageGbMonthMicro: storageGbMonthMicroUnits(totals.storage_byte_seconds),
    });
    expect(invoice.totalMicroUsd).toBe(2_500_000);
    // Historical per-row estimates stay as written (v1 rows at $0.10): not used for billing.
    // 5 GB-month at $0.10 (days 20–25) + 5 GB-month at $0.05 (days 25–30).
    expect(rows.reduce((s, r) => s + r.estimatedCostMicroUsd, 0)).toBe(750_000);
  });
});
