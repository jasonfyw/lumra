import { BILLING_POLICY_V1, BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import { InvalidTransitionError } from '@lumra/domain';
import { describe, expect, it } from 'vitest';
import {
  BILLING_ACCOUNT_TRANSITIONS,
  LedgerEntryError,
  MeterExportError,
  RateVersionMismatchError,
  alertThresholdsCrossed,
  assertBillingTransition,
  buildLedgerEntry,
  buildMeterEvents,
  bytesToGbMicroUnits,
  checkAdmission,
  checkDeliveryAllowance,
  checkGalleryCreation,
  deriveBillingRestrictions,
  divRoundHalfUp,
  estimateOverageMicroUsd,
  exceedsCapTolerance,
  integrateStorage,
  meterCursorKey,
  microUsdToCents,
  rateInvoice,
  spendCapToleranceMicroUsd,
  storageGbMonthMicroUnits,
  storageWindowSourceId,
  type AdmissionInput,
} from './index';

const { free, pro } = RATE_CARD_V1;
const GB = BYTES_PER_GB;
const MONTH_S = BILLING_POLICY_V1.secondsPerBillingMonth;
const DAY_MS = 86_400_000;
const periodStart = new Date('2026-11-01T00:00:00Z');
const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
const at = (days: number): Date => new Date(periodStart.getTime() + days * DAY_MS);

describe('units and rounding', () => {
  it('rounds half up', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
    expect(divRoundHalfUp(25n, 10n)).toBe(3n); // not banker's (would be 2)
  });

  it('converts byte-seconds to micro GB-months with the 30-day convention', () => {
    expect(storageGbMonthMicroUnits(BigInt(GB) * BigInt(MONTH_S))).toBe(1_000_000n);
    expect(storageGbMonthMicroUnits(12n * BigInt(GB) * BigInt(MONTH_S))).toBe(12_000_000n);
    // divisor is 2 592 000 000 byte-seconds per micro GB-month
    expect(storageGbMonthMicroUnits(1_295_999_999n)).toBe(0n);
    expect(storageGbMonthMicroUnits(1_296_000_000n)).toBe(1n);
  });

  it('converts bytes to micro GB and micro-USD to cents half up', () => {
    expect(bytesToGbMicroUnits(1_499)).toBe(1n);
    expect(bytesToGbMicroUnits(1_500)).toBe(2n);
    expect(microUsdToCents(4_204_999)).toBe(420);
    expect(microUsdToCents(4_205_000)).toBe(421);
    expect(() => microUsdToCents(1.5)).toThrow(RangeError);
    expect(() => microUsdToCents(-1)).toThrow(RangeError);
  });
});

describe('integrateStorage', () => {
  it('integrates a step function exactly', () => {
    const result = integrateStorage(
      [
        { type: 'delta', at: at(10), bytes: 2 * GB },
        { type: 'snapshot', at: at(20), storedBytes: 1 * GB },
      ],
      periodStart,
      periodEnd,
      1 * GB,
    );
    // 1 GB × 10 d + 3 GB × 10 d + 1 GB × 10 d = 5 GB × 10 d
    expect(result.byteSeconds).toBe(5n * BigInt(GB) * 10n * 86_400n);
    expect(result.closingStoredBytes).toBe(GB);
    expect(result.peakStoredBytes).toBe(3 * GB);
  });

  it('applies pre-period events to the opening level and ignores post-period events', () => {
    const result = integrateStorage(
      [
        { type: 'delta', at: at(40), bytes: 5 * GB },
        { type: 'delta', at: new Date(periodStart.getTime() - 1), bytes: GB },
      ],
      periodStart,
      periodEnd,
    );
    expect(result.byteSeconds).toBe(BigInt(GB) * BigInt(MONTH_S));
    expect(result.closingStoredBytes).toBe(GB);
  });

  it('handles sub-second timestamps with one half-up rounding', () => {
    const start = new Date(0);
    const r = integrateStorage([], start, new Date(500), 1);
    expect(r.byteSeconds).toBe(1n); // 0.5 byte-second rounds up
    expect(integrateStorage([], start, new Date(499), 1).byteSeconds).toBe(0n);
  });

  it('rejects negative levels', () => {
    expect(() =>
      integrateStorage([{ type: 'delta', at: at(1), bytes: -1 }], periodStart, periodEnd, 0),
    ).toThrow(RangeError);
  });
});

describe('rateInvoice', () => {
  it('reproduces the PRD §9.3 example: Pro, 30 GB-month, 45 GB ⇒ $4.20', () => {
    const invoice = rateInvoice({
      plan: pro,
      storageGbMonthMicro: storageGbMonthMicroUnits(30n * BigInt(GB) * BigInt(MONTH_S)),
      deliveryBytes: 45 * GB,
      rateVersion: pro.rateVersion,
    });
    expect(invoice.totalMicroUsd).toBe(4_200_000);
    expect(invoice.totalCents).toBe(420);
    expect(invoice.lines.map((l) => [l.kind, l.amountMicroUsd, l.amountCents])).toEqual([
      ['base_fee', 2_000_000, 200],
      ['storage_overage', 1_000_000, 100],
      ['delivery_overage', 1_200_000, 120],
    ]);
    expect(invoice.lines[1]?.quantity).toBe(10_000_000n);
    expect(invoice.lines[2]?.quantity).toBe(40n * BigInt(GB));
  });

  it('charges only the base fee inside the allowance', () => {
    const invoice = rateInvoice({
      plan: pro,
      storageGbMonthMicro: 2_000_000,
      deliveryBytes: 5 * GB,
      rateVersion: 1,
    });
    expect(invoice.totalMicroUsd).toBe(pro.monthlyFeeMicroUsd);
  });

  it('never produces overage lines on Free', () => {
    const invoice = rateInvoice({
      plan: free,
      storageGbMonthMicro: 999_000_000,
      deliveryBytes: 999 * GB,
      rateVersion: 1,
    });
    expect(invoice.lines.map((l) => l.kind)).toEqual(['base_fee']);
    expect(invoice.totalMicroUsd).toBe(0);
  });

  it('rejects usage rated under a different rate version', () => {
    expect(() =>
      rateInvoice({ plan: pro, storageGbMonthMicro: 0, deliveryBytes: 0, rateVersion: 2 }),
    ).toThrow(RateVersionMismatchError);
  });

  it('rounds sub-micro-dollar delivery half up', () => {
    // 1 byte over: 30 000 µ$/GB × 1e-9 GB = 0.00003 µ$ → 0
    expect(
      estimateOverageMicroUsd({ storageByteSeconds: 0n, deliveryBytes: 5 * GB + 1 }, pro),
    ).toBe(0);
    // 16 667 bytes over → 0.50001 µ$ → 1
    expect(
      estimateOverageMicroUsd({ storageByteSeconds: 0n, deliveryBytes: 5 * GB + 16_667 }, pro),
    ).toBe(1);
  });
});

const baseAdmission = (overrides: Partial<AdmissionInput> = {}): AdmissionInput => ({
  plan: pro,
  account: { status: 'active' },
  now: at(15),
  period: { start: periodStart, end: periodEnd },
  currentUsage: { storedBytes: 0, storageByteSecondsToDate: 0n, deliveryBytesToDate: 0 },
  reservations: [],
  requested: { kind: 'upload', bytes: 50_000_000 },
  capMicroUsd: null,
  ...overrides,
});

describe('checkAdmission', () => {
  it('enforces the Free 1 GB stored cap including pending reservations', () => {
    const input = baseAdmission({
      plan: free,
      account: { status: 'free' },
      currentUsage: {
        storedBytes: 900_000_000,
        storageByteSecondsToDate: 0n,
        deliveryBytesToDate: 0,
      },
      reservations: [{ kind: 'upload', bytes: 50_000_000 }],
    });
    expect(checkAdmission(input).allowed).toBe(true); // exactly 1 GB
    expect(
      checkAdmission({ ...input, requested: { kind: 'upload', bytes: 50_000_001 } }),
    ).toMatchObject({ allowed: false, reason: 'free_storage_cap' });
  });

  it('enforces the Free 3 GB/month delivery cap for archives', () => {
    const input = baseAdmission({
      plan: free,
      account: { status: 'free' },
      currentUsage: { storedBytes: 0, storageByteSecondsToDate: 0n, deliveryBytesToDate: 2 * GB },
      requested: { kind: 'archive', bytes: GB },
    });
    expect(checkAdmission(input).allowed).toBe(true);
    expect(
      checkAdmission({ ...input, reservations: [{ kind: 'archive', bytes: 1 }] }),
    ).toMatchObject({ allowed: false, reason: 'free_delivery_cap' });
  });

  it('honours an explicit freeLimits override', () => {
    expect(
      checkAdmission(
        baseAdmission({
          plan: free,
          account: { status: 'free' },
          freeLimits: { maxStorageBytes: 10, maxDeliveryBytesPerMonth: 10 },
          requested: { kind: 'upload', bytes: 11 },
        }),
      ),
    ).toMatchObject({ allowed: false, reason: 'free_storage_cap' });
  });

  it('denies Pro uploads whose conservative projection exceeds the spend cap', () => {
    // Half the period left: 1 TB held for 15 days = 500 GB-month → 480 × $0.10 = $48.00 overage
    const input = baseAdmission({ requested: { kind: 'upload', bytes: 1_000 * GB } });
    const decision = checkAdmission(input);
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'spend_cap',
      remainingCapMicroUsd: 0,
    });
    expect(decision.projectedOverageMicroUsd).toBe(48_000_000);
    expect(checkAdmission({ ...input, capMicroUsd: 50 * 1_000_000 }).allowed).toBe(true);
  });

  it('treats a $0 cap as no overage at all', () => {
    const input = baseAdmission({ capMicroUsd: 0, requested: { kind: 'archive', bytes: 5 * GB } });
    expect(checkAdmission(input).allowed).toBe(true); // exactly the allowance
    expect(
      checkAdmission({ ...input, requested: { kind: 'archive', bytes: 5 * GB + 20_000 } }),
    ).toMatchObject({ allowed: false, reason: 'spend_cap' });
  });

  it('stops uploads and archives immediately when past_due', () => {
    const account = { status: 'past_due' as const, pastDueSince: at(14) };
    expect(checkAdmission(baseAdmission({ account }))).toMatchObject({
      allowed: false,
      reason: 'past_due',
    });
    expect(
      checkAdmission(baseAdmission({ account, requested: { kind: 'archive', bytes: 1 } })),
    ).toMatchObject({ allowed: false, reason: 'past_due' });
  });
});

describe('checkGalleryCreation', () => {
  it('allows 2 active galleries on Free and unlimited on Pro', () => {
    expect(checkGalleryCreation({ plan: free, activeGalleryCount: 1 })).toEqual({ allowed: true });
    expect(checkGalleryCreation({ plan: free, activeGalleryCount: 2 })).toEqual({
      allowed: false,
      reason: 'free_gallery_cap',
    });
    expect(checkGalleryCreation({ plan: pro, activeGalleryCount: 10_000 })).toEqual({
      allowed: true,
    });
  });
});

describe('checkDeliveryAllowance', () => {
  const usage = (deliveryBytesToDate: number) => ({
    storageByteSecondsToDate: 0n,
    deliveryBytesToDate,
  });

  it('pauses Free delivery at 3 GB and Pro delivery at the cap', () => {
    const freeInput = {
      plan: free,
      account: { status: 'free' as const },
      now: at(1),
      capMicroUsd: null,
    };
    expect(checkDeliveryAllowance({ ...freeInput, usage: usage(3 * GB - 1) }).allowed).toBe(true);
    expect(checkDeliveryAllowance({ ...freeInput, usage: usage(3 * GB) })).toEqual({
      allowed: false,
      reason: 'free_delivery_cap',
    });
    // $10 cap = 333.33 GB over the 5 GB allowance at $0.03/GB
    const proInput = {
      plan: pro,
      account: { status: 'active' as const },
      now: at(1),
      capMicroUsd: null,
    };
    expect(checkDeliveryAllowance({ ...proInput, usage: usage(338 * GB) }).allowed).toBe(true);
    expect(checkDeliveryAllowance({ ...proInput, usage: usage(339 * GB) })).toEqual({
      allowed: false,
      reason: 'spend_cap',
    });
  });

  it('suspends public delivery only after the past-due grace', () => {
    const input = {
      plan: pro,
      account: { status: 'past_due' as const, pastDueSince: at(0) },
      usage: usage(0),
      capMicroUsd: null,
    };
    expect(checkDeliveryAllowance({ ...input, now: new Date(at(7).getTime() - 1) }).allowed).toBe(
      true,
    );
    expect(checkDeliveryAllowance({ ...input, now: at(7) })).toEqual({
      allowed: false,
      reason: 'past_due',
    });
  });
});

describe('spend cap tolerance and alerts', () => {
  it('uses max(10 % of cap, $0.25)', () => {
    expect(spendCapToleranceMicroUsd(10_000_000)).toBe(1_000_000);
    expect(spendCapToleranceMicroUsd(0)).toBe(250_000);
    expect(exceedsCapTolerance(11_000_000, 10_000_000)).toBe(false);
    expect(exceedsCapTolerance(11_000_001, 10_000_000)).toBe(true);
  });

  it('returns only newly crossed thresholds', () => {
    const cap = 10_000_000;
    expect(alertThresholdsCrossed(0, 4_999_999, cap)).toEqual([]);
    expect(alertThresholdsCrossed(0, 5_000_000, cap)).toEqual([50]);
    expect(alertThresholdsCrossed(5_000_000, 10_000_000, cap)).toEqual([80, 100]);
    expect(alertThresholdsCrossed(10_000_000, 12_000_000, cap)).toEqual([]);
    expect(alertThresholdsCrossed(0, 1, 0)).toEqual([50, 80, 100]);
    expect(alertThresholdsCrossed(0, 0, 0)).toEqual([]);
  });
});

describe('billing account state machine', () => {
  it('follows the PRD §7 transitions', () => {
    expect(BILLING_ACCOUNT_TRANSITIONS.free).toEqual(['active']);
    expect(() => assertBillingTransition('free', 'past_due')).toThrow(InvalidTransitionError);
    expect(() => assertBillingTransition('past_due', 'restricted')).not.toThrow();
  });

  it('derives the §9.4 past-due timeline', () => {
    const account = { status: 'past_due' as const, pastDueSince: at(0) };
    const during = deriveBillingRestrictions(account, at(3));
    expect(during).toMatchObject({
      effectiveStatus: 'past_due',
      uploadsAllowed: false,
      archivesAllowed: false,
      publicDeliveryAllowed: true,
    });
    expect(during.deliverySuspendsAt).toEqual(at(7));
    expect(during.retentionEndsAt).toEqual(at(37));

    const after = deriveBillingRestrictions(account, at(8));
    expect(after).toMatchObject({ effectiveStatus: 'restricted', publicDeliveryAllowed: false });

    const restricted = deriveBillingRestrictions(
      { status: 'restricted', restrictedSince: at(9) },
      at(10),
    );
    expect(restricted.retentionEndsAt).toEqual(at(39));
    expect(deriveBillingRestrictions({ status: 'active' }, at(10)).uploadsAllowed).toBe(true);
  });

  it('requires the timestamps policy depends on', () => {
    expect(() => deriveBillingRestrictions({ status: 'past_due' }, at(1))).toThrow();
  });
});

describe('ledger entries', () => {
  const period = { start: periodStart, end: periodEnd };

  it('builds deterministic rows keyed by (metric, sourceId)', () => {
    const input = {
      accountId: 'acct_1',
      metric: 'delivery_bytes' as const,
      quantity: 1_234,
      unit: 'byte' as const,
      sourceId: 'gw_evt_1',
      eventTime: at(2),
      period,
      rateVersion: 1,
    };
    const entry = buildLedgerEntry(input);
    expect(entry).toEqual(buildLedgerEntry(input));
    expect(entry.idempotencyKey).toBe('delivery_bytes:gw_evt_1');
    expect(entry.quantity).toBe(1_234n);
    expect(entry.periodStart).toEqual(periodStart);
  });

  it('rejects mismatched units, negative or fractional quantities and out-of-period times', () => {
    const base = {
      accountId: 'a',
      metric: 'storage_byte_seconds' as const,
      quantity: 1n,
      unit: 'byte_second' as const,
      sourceId: storageWindowSourceId('a', at(0), at(1)),
      eventTime: at(1),
      period,
      rateVersion: 1,
    };
    expect(() => buildLedgerEntry(base)).not.toThrow();
    expect(() => buildLedgerEntry({ ...base, unit: 'byte' })).toThrow(LedgerEntryError);
    expect(() => buildLedgerEntry({ ...base, quantity: -1n })).toThrow(LedgerEntryError);
    expect(() => buildLedgerEntry({ ...base, quantity: 0.5 })).toThrow(LedgerEntryError);
    expect(() => buildLedgerEntry({ ...base, eventTime: at(31) })).toThrow(LedgerEntryError);
  });
});

describe('buildMeterEvents', () => {
  const period = { start: periodStart, end: periodEnd };
  const delivery = (sourceId: string, quantity: number, day: number) =>
    buildLedgerEntry({
      accountId: 'acct_1',
      metric: 'delivery_bytes',
      quantity,
      unit: 'byte',
      sourceId,
      eventTime: at(day),
      period,
      rateVersion: 1,
    });

  it('exports cumulative overage deltas in MB with stable identifiers', () => {
    const included = RATE_CARD_V1.pro.includedDeliveryGb * BYTES_PER_GB;
    // Day 1: allowance + 1.4 MB; day 2: another 1.4 MB.
    const entries = [delivery('e1', included + 1_400_000, 1), delivery('e2', 1_400_000, 2)];
    const day1 = buildMeterEvents({
      stripeCustomerId: 'cus_1',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.pro,
      windowEnd: at(1),
      entries,
      exported: {},
    });
    expect(day1.events).toEqual([
      {
        event_name: 'lumra_delivery_overage',
        identifier: `acct_1:delivery_bytes:${periodStart.getTime() / 1000}:${at(1).getTime() / 1000}`,
        timestamp: at(1).getTime() / 1000,
        payload: { stripe_customer_id: 'cus_1', value: '1' },
      },
    ]);
    const day2 = buildMeterEvents({
      stripeCustomerId: 'cus_1',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.pro,
      windowEnd: at(2),
      entries,
      exported: day1.cursors,
    });
    // 2.8 MB → 3 MB in total; per-day rounding would have exported 1 + 1 = 2.
    expect(day2.events.map((e) => e.payload.value)).toEqual(['2']);
    expect(day2.cursors[meterCursorKey('delivery_bytes', periodStart)]).toBe(3n);
  });

  it('exports storage as MB-months above the included GB-months', () => {
    const month = BigInt(BILLING_POLICY_V1.secondsPerBillingMonth);
    const gbMonth = BigInt(BYTES_PER_GB) * month;
    const storage = buildLedgerEntry({
      accountId: 'acct_1',
      metric: 'storage_byte_seconds',
      // 30 GB-month: 10 GB-month = 10 000 MB-month over the 20 included.
      quantity: 30n * gbMonth,
      unit: 'byte_second',
      sourceId: 's1',
      eventTime: at(3),
      period,
      rateVersion: 1,
    });
    const result = buildMeterEvents({
      stripeCustomerId: 'cus_1',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.pro,
      windowEnd: at(3),
      entries: [storage],
      exported: {},
    });
    expect(result.events.map((e) => [e.event_name, e.payload.value])).toEqual([
      ['lumra_storage_overage', '10000'],
    ]);
  });

  it('timestamps usage exported after the period closed inside that period', () => {
    const late = buildMeterEvents({
      stripeCustomerId: 'cus_1',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.pro,
      windowEnd: at(31),
      entries: [delivery('e1', 6 * BYTES_PER_GB, 29)],
      exported: {},
      periodEndFor: () => periodEnd,
    });
    expect(late.events[0]?.timestamp).toBe(periodEnd.getTime() / 1000 - 1);
    expect(late.events[0]?.identifier.endsWith(`:${at(31).getTime() / 1000}`)).toBe(true);
  });

  it('never exports anything for Free', () => {
    const free = buildMeterEvents({
      stripeCustomerId: 'c',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.free,
      windowEnd: at(2),
      entries: [delivery('e1', 50 * BYTES_PER_GB, 1)],
      exported: {},
    });
    expect(free.events).toEqual([]);
  });

  it('emits nothing when nothing new is billable and rejects foreign or conflicting rows', () => {
    const entries = [delivery('e1', 10, 1)];
    const first = buildMeterEvents({
      stripeCustomerId: 'c',
      accountId: 'acct_1',
      plan: RATE_CARD_V1.pro,
      windowEnd: at(1),
      entries,
      exported: {},
    });
    expect(first.events).toEqual([]);
    expect(() =>
      buildMeterEvents({
        stripeCustomerId: 'c',
        accountId: 'other',
        plan: RATE_CARD_V1.pro,
        windowEnd: at(1),
        entries,
        exported: {},
      }),
    ).toThrow(MeterExportError);
    expect(() =>
      buildMeterEvents({
        stripeCustomerId: 'c',
        accountId: 'acct_1',
        plan: RATE_CARD_V1.pro,
        windowEnd: at(2),
        entries: [delivery('e1', 10, 1), delivery('e1', 11, 1)],
        exported: {},
      }),
    ).toThrow(MeterExportError);
  });
});
