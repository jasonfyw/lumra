import { BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import {
  evaluateBillingSafeguards,
  isValidSpendCap,
  newAlertThresholds,
  parseUsdToMicroUsd,
  reconcileInvoice,
  thresholdsReached,
  type SafeguardContext,
} from './index';

const pro = RATE_CARD_V1.pro;

describe('spend-cap alerts (T32)', () => {
  it('reaches 50/80/100 % of the cap, never at zero spend', () => {
    expect(thresholdsReached(0, 10_000_000)).toEqual([]);
    expect(thresholdsReached(4_999_999, 10_000_000)).toEqual([]);
    expect(thresholdsReached(5_000_000, 10_000_000)).toEqual([50]);
    expect(thresholdsReached(10_000_000, 10_000_000)).toEqual([50, 80, 100]);
    expect(thresholdsReached(1, 0)).toEqual([50, 80, 100]);
  });

  it('dedupes against thresholds already recorded this period', () => {
    expect(newAlertThresholds(9_000_000, 10_000_000, [50, 80, 100], [50])).toEqual([80]);
    expect(newAlertThresholds(9_000_000, 10_000_000, [50, 80, 100], [50, 80])).toEqual([]);
  });

  it('evaluateBillingSafeguards records only new thresholds for Pro and never for Free', async () => {
    const recorded: unknown[][] = [];
    const base: SafeguardContext = {
      accountId: 'p',
      plan: pro,
      account: { status: 'active', pastDueSince: null, restrictedSince: null, canceledAt: null },
      spendCapMicroUsd: 10_000_000,
      warningThresholdsPct: [50, 80, 100],
      deliveryPausedReason: null,
      period: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') },
      // 5 GB included + 200 GB × $0.03 = $6.00 overage → 50 % reached.
      usage: { storageByteSecondsToDate: 0n, deliveryBytesToDate: 205 * BYTES_PER_GB },
      alertsSent: [],
    };
    const free: SafeguardContext = {
      ...base,
      accountId: 'f',
      plan: RATE_CARD_V1.free,
      spendCapMicroUsd: null,
      account: { ...base.account, status: 'free' },
      usage: { storageByteSecondsToDate: 0n, deliveryBytesToDate: 0 },
    };
    const result = await evaluateBillingSafeguards(['p', 'f', 's'], {
      now: new Date('2026-11-13T00:00:00Z'),
      traceId: 't',
      store: {
        safeguardContexts: async () => [base, free, { ...base, accountId: 's', alertsSent: [50] }],
        setDeliveryPause: async () => true,
        recordSpendAlerts: async (...args) => {
          recorded.push(args);
          return args[2];
        },
      },
    });
    expect(result.alerts).toBe(1);
    expect(recorded).toEqual([
      [
        'p',
        base.period.start,
        [50],
        { spendMicroUsd: 6_000_000, capMicroUsd: 10_000_000, traceId: 't' },
      ],
    ]);
  });
});

describe('spending cap input', () => {
  it('parses dollars without floating point', () => {
    expect(parseUsdToMicroUsd('10')).toBe(10_000_000);
    expect(parseUsdToMicroUsd('$12.5')).toBe(12_500_000);
    expect(parseUsdToMicroUsd(' 0.07 ')).toBe(70_000);
    expect(parseUsdToMicroUsd('1.234')).toBeNull();
    expect(parseUsdToMicroUsd('-1')).toBeNull();
    expect(parseUsdToMicroUsd('1e3')).toBeNull();
  });

  it('accepts $0 to the platform maximum in whole cents', () => {
    expect(isValidSpendCap(0)).toBe(true);
    expect(isValidSpendCap(500_000_000)).toBe(true);
    expect(isValidSpendCap(500_010_000)).toBe(false);
    expect(isValidSpendCap(10_005)).toBe(false);
    expect(isValidSpendCap(-10_000)).toBe(false);
  });
});

describe('reconcileInvoice (T31)', () => {
  const month = 30n * 86_400n;
  const usage = {
    storageByteSeconds: 30n * BigInt(BYTES_PER_GB) * month,
    deliveryBytes: 45 * BYTES_PER_GB,
  };
  const rec = (stripeSubtotalCents: number, capMicroUsd: number | null, firstInvoice = false) =>
    reconcileInvoice({ plan: pro, usage, stripeSubtotalCents, firstInvoice, capMicroUsd });

  it('matches the PRD example and tolerates a cent of rounding', () => {
    expect(rec(420, 10_000_000)).toMatchObject({
      expectedCents: 420,
      driftBps: 0,
      flagged: false,
      overageMicroUsd: 2_200_000,
    });
    expect(rec(421, null).flagged).toBe(false);
  });

  it('flags drift above 10 % and overage beyond cap + tolerance', () => {
    const drift = rec(520, 2_000_000);
    expect(drift.flagged).toBe(true);
    expect(drift.exceedsCapTolerance).toBe(false); // $2.20 ≤ $2.00 + $0.25
    expect(rec(420, 1_000_000).exceedsCapTolerance).toBe(true);
  });

  it('the first invoice is the base fee only', () => {
    expect(rec(200, null, true)).toMatchObject({ expectedCents: 200, flagged: false });
  });
});
