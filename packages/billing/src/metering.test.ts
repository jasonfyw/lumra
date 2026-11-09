import { BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { USAGE_METRICS, sumLedger } from './ledger';
import {
  METERED_ACTIONS,
  billingPeriodAt,
  planStorageAccrual,
  rateDeliveryEvents,
  type DeliveryAccountContext,
} from './metering';
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

describe('rateDeliveryEvents', () => {
  const accounts = new Map<string, DeliveryAccountContext>([
    [acct, { account: null, plan: pro }],
    ['free-acct', { account: null, plan: free }],
  ]);
  const servedAt = new Date('2026-11-09T12:00:00Z');

  it('builds one delivery_bytes row per event, deduping repeated source ids in a batch', () => {
    const entries = rateDeliveryEvents({
      events: [
        { sourceId: 'jti-a:0-99', accountId: acct, bytes: 100, servedAt },
        { sourceId: 'jti-a:0-99', accountId: acct, bytes: 100, servedAt },
        { sourceId: 'jti-b:0-49', accountId: acct, bytes: 50, servedAt },
      ],
      accounts,
      deliveryBytesToDate: () => 0n,
    });
    expect(entries.map((e) => [e.sourceId, e.quantity, e.unit])).toEqual([
      ['jti-a:0-99', 100n, 'byte'],
      ['jti-b:0-49', 50n, 'byte'],
    ]);
    expect(entries[0]!.idempotencyKey).toBe('delivery_bytes:jti-a:0-99');
    expect(entries[0]!.periodStart).toEqual(new Date('2026-11-01T00:00:00Z'));
  });

  it('prices only bytes beyond the allowance, cumulatively across the batch', () => {
    const fiveGb = 5n * BigInt(GB);
    const entries = rateDeliveryEvents({
      events: [
        { sourceId: 'a', accountId: acct, bytes: GB / 2, servedAt },
        { sourceId: 'b', accountId: acct, bytes: GB, servedAt: new Date(servedAt.getTime() + 1) },
      ],
      accounts,
      deliveryBytesToDate: () => fiveGb - BigInt(GB / 2),
    });
    // First half-GB fills the allowance exactly; the next GB is $0.03.
    expect(entries.map((e) => e.estimatedCostMicroUsd)).toEqual([0, 30_000]);
  });

  it('never prices Free delivery', () => {
    const [row] = rateDeliveryEvents({
      events: [{ sourceId: 'f', accountId: 'free-acct', bytes: 10 * GB, servedAt }],
      accounts,
      deliveryBytesToDate: () => 100n * BigInt(GB),
    });
    expect(row!.estimatedCostMicroUsd).toBe(0);
  });

  it('throws for an account without billing context', () => {
    expect(() =>
      rateDeliveryEvents({
        events: [{ sourceId: 'x', accountId: 'unknown', bytes: 1, servedAt }],
        accounts,
        deliveryBytesToDate: () => 0n,
      }),
    ).toThrow();
  });
});

describe('ledger coverage', () => {
  it('every usage metric has a metered-action producer', () => {
    expect(Object.keys(METERED_ACTIONS).sort()).toEqual([...USAGE_METRICS].sort());
  });

  it('metered rows for the PRD §9.3 example rate to exactly $4.20', () => {
    // 30 GB stored for a whole 30-day month, accrued hourly; 45 GB delivered in 45 responses.
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
    rows.push(
      ...rateDeliveryEvents({
        events: Array.from({ length: 45 }, (_, i) => ({
          sourceId: `jti-${i}:0-${GB - 1}`,
          accountId: acct,
          bytes: GB,
          servedAt: new Date(start.getTime() + i * HOUR),
        })),
        accounts: new Map([[acct, { account: null, plan: pro }]]),
        deliveryBytesToDate: () => 0n,
      }),
    );
    const totals = sumLedger(rows);
    const invoice = rateInvoice({
      plan: pro,
      rateVersion: 1,
      storageGbMonthMicro: storageGbMonthMicroUnits(totals.storage_byte_seconds),
      deliveryBytes: totals.delivery_bytes,
    });
    expect(invoice.totalMicroUsd).toBe(4_200_000);
    expect(invoice.totalCents).toBe(420);
    // Row-level estimates add up to the same overage (no hidden rounding drift).
    expect(rows.reduce((s, r) => s + r.estimatedCostMicroUsd, 0)).toBe(2_200_000);
  });
});
