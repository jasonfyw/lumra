import { BYTES_PER_GB, RATE_CARD_V1 } from '@lumra/config';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  alertThresholdsCrossed,
  buildLedgerEntry,
  buildMeterEvents,
  checkAdmission,
  computeOverage,
  estimateOverageMicroUsd,
  integrateStorage,
  rateInvoice,
  storageGbMonthMicroUnits,
  type LedgerEntry,
  type StorageEvent,
} from './index';

const { free, pro } = RATE_CARD_V1;
const plans = fc.constantFrom(free, pro);
const periodStart = new Date('2026-11-01T00:00:00Z');
const periodEnd = new Date('2026-12-01T00:00:00Z');
const span = periodEnd.getTime() - periodStart.getTime();

/** fc.integer is limited to 32 bits; draw larger safe integers via bigint. */
const int = (min: number, max: number) =>
  fc.bigInt({ min: BigInt(min), max: BigInt(max) }).map(Number);

const byteSeconds = fc.bigInt({ min: 0n, max: 10n ** 19n });
const deliveryBytes = int(0, 10 ** 15);

describe('rating properties', () => {
  it('Free never yields a positive overage or extra line', () => {
    fc.assert(
      fc.property(byteSeconds, deliveryBytes, (bs, d) => {
        expect(estimateOverageMicroUsd({ storageByteSeconds: bs, deliveryBytes: d }, free)).toBe(0);
        const invoice = rateInvoice({
          plan: free,
          storageGbMonthMicro: storageGbMonthMicroUnits(bs),
          deliveryBytes: d,
          rateVersion: free.rateVersion,
        });
        expect(invoice.lines).toHaveLength(1);
        expect(invoice.totalMicroUsd).toBe(0);
      }),
    );
  });

  it('is monotonic in usage', () => {
    fc.assert(
      fc.property(
        plans,
        byteSeconds,
        byteSeconds,
        deliveryBytes,
        deliveryBytes,
        (plan, a, b, c, d) => {
          const [s1, s2] = a <= b ? [a, b] : [b, a];
          const [d1, d2] = c <= d ? [c, d] : [d, c];
          expect(
            estimateOverageMicroUsd({ storageByteSeconds: s1, deliveryBytes: d1 }, plan),
          ).toBeLessThanOrEqual(
            estimateOverageMicroUsd({ storageByteSeconds: s2, deliveryBytes: d2 }, plan),
          );
        },
      ),
    );
  });

  it('produces integer-only money that adds up', () => {
    fc.assert(
      fc.property(plans, byteSeconds, deliveryBytes, (plan, bs, d) => {
        const invoice = rateInvoice({
          plan,
          storageGbMonthMicro: storageGbMonthMicroUnits(bs),
          deliveryBytes: d,
          rateVersion: plan.rateVersion,
        });
        for (const line of invoice.lines) {
          expect(Number.isSafeInteger(line.amountMicroUsd)).toBe(true);
          expect(Number.isSafeInteger(line.amountCents)).toBe(true);
          expect(line.amountMicroUsd).toBeGreaterThanOrEqual(0);
          // per-line cents are within half a cent of the micro-USD amount
          expect(Math.abs(line.amountCents * 10_000 - line.amountMicroUsd)).toBeLessThanOrEqual(
            5_000,
          );
        }
        expect(invoice.totalMicroUsd).toBe(invoice.lines.reduce((s, l) => s + l.amountMicroUsd, 0));
        expect(invoice.totalCents).toBe(invoice.lines.reduce((s, l) => s + l.amountCents, 0));
        expect(invoice.totalMicroUsd - plan.monthlyFeeMicroUsd).toBe(
          estimateOverageMicroUsd({ storageByteSeconds: bs, deliveryBytes: d }, plan),
        );
      }),
    );
  });

  it('charges exactly rate × whole GB above the allowance', () => {
    fc.assert(
      fc.property(int(0, 100_000), int(0, 100_000), (s, d) => {
        const o = computeOverage(pro, BigInt(s) * 1_000_000n, d * BYTES_PER_GB);
        expect(o.storageOverageMicroUsd).toBe(
          Math.max(0, s - pro.includedStorageGbMonth) * (pro.storageOverageMicroUsdPerGbMonth ?? 0),
        );
        expect(o.deliveryOverageMicroUsd).toBe(
          Math.max(0, d - pro.includedDeliveryGb) * (pro.deliveryOverageMicroUsdPerGb ?? 0),
        );
      }),
    );
  });
});

const storageEvents = fc.array(
  fc.record({
    offset: int(0, span - 1),
    bytes: int(0, 10 * BYTES_PER_GB),
  }),
  { maxLength: 30 },
);

describe('storage integration properties', () => {
  it('equals a direct sum of level × duration for additive events', () => {
    fc.assert(
      fc.property(storageEvents, int(0, BYTES_PER_GB), (raw, opening) => {
        const events: StorageEvent[] = raw.map((e) => ({
          type: 'delta',
          at: new Date(periodStart.getTime() + e.offset),
          bytes: e.bytes,
        }));
        // each delta contributes bytes × (end − at); opening contributes opening × span
        let byteMs = BigInt(opening) * BigInt(span);
        for (const e of raw) byteMs += BigInt(e.bytes) * BigInt(span - e.offset);
        const result = integrateStorage(events, periodStart, periodEnd, opening);
        expect(result.byteSeconds).toBe((2n * byteMs + 1000n) / 2000n);
      }),
    );
  });

  it('is independent of event input order', () => {
    fc.assert(
      fc.property(storageEvents, (raw) => {
        const events: StorageEvent[] = raw.map((e) => ({
          type: 'delta',
          at: new Date(periodStart.getTime() + e.offset),
          bytes: e.bytes,
        }));
        const a = integrateStorage(events, periodStart, periodEnd);
        const b = integrateStorage([...events].reverse(), periodStart, periodEnd);
        expect(a.byteSeconds).toBe(b.byteSeconds);
        expect(a.closingStoredBytes).toBe(b.closingStoredBytes);
      }),
    );
  });
});

describe('admission properties', () => {
  it('a Free account can never be admitted into a positive projected overage', () => {
    fc.assert(
      fc.property(
        int(0, 2 * BYTES_PER_GB),
        int(0, 5 * BYTES_PER_GB),
        fc.constantFrom('upload' as const, 'archive' as const),
        int(0, 2 * BYTES_PER_GB),
        int(0, span),
        (stored, delivered, kind, bytes, elapsed) => {
          const decision = checkAdmission({
            plan: free,
            account: { status: 'free' },
            now: new Date(periodStart.getTime() + elapsed),
            period: { start: periodStart, end: periodEnd },
            currentUsage: {
              storedBytes: stored,
              storageByteSecondsToDate: BigInt(stored) * BigInt(Math.floor(elapsed / 1000)),
              deliveryBytesToDate: delivered,
            },
            reservations: [],
            requested: { kind, bytes },
            capMicroUsd: null,
          });
          expect(decision.projectedOverageMicroUsd).toBe(0);
          if (decision.allowed && kind === 'upload') {
            expect(stored + bytes).toBeLessThanOrEqual(free.maxStorageBytes ?? 0);
          }
          if (decision.allowed && kind === 'archive') {
            expect(delivered + bytes).toBeLessThanOrEqual(free.maxDeliveryBytesPerMonth ?? 0);
          }
        },
      ),
    );
  });

  it('a Pro admission never projects above the cap', () => {
    fc.assert(
      fc.property(
        int(0, 500 * BYTES_PER_GB),
        int(0, 500 * BYTES_PER_GB),
        int(0, 50_000_000),
        (stored, bytes, cap) => {
          const decision = checkAdmission({
            plan: pro,
            account: { status: 'active' },
            now: periodStart,
            period: { start: periodStart, end: periodEnd },
            currentUsage: {
              storedBytes: stored,
              storageByteSecondsToDate: 0n,
              deliveryBytesToDate: 0,
            },
            reservations: [],
            requested: { kind: 'upload', bytes },
            capMicroUsd: cap,
          });
          if (decision.allowed) expect(decision.projectedOverageMicroUsd).toBeLessThanOrEqual(cap);
          else expect(decision.reason).toBe('spend_cap');
        },
      ),
    );
  });
});

describe('alert properties', () => {
  it('raising spend in steps alerts each threshold exactly once', () => {
    fc.assert(
      fc.property(
        int(0, 100_000_000),
        fc.array(int(0, 5_000_000), { maxLength: 40 }),
        (cap, steps) => {
          let spend = 0;
          const fired: number[] = [];
          for (const step of steps) {
            fired.push(...alertThresholdsCrossed(spend, spend + step, cap));
            spend += step;
          }
          expect(new Set(fired).size).toBe(fired.length);
          expect(fired.sort((a, b) => a - b)).toEqual(alertThresholdsCrossed(0, spend, cap));
        },
      ),
    );
  });
});

describe('meter export properties', () => {
  const period = { start: periodStart, end: periodEnd };
  const entriesArb = fc
    .array(
      fc.record({
        metric: fc.constantFrom('storage_byte_seconds' as const, 'delivery_bytes' as const),
        quantity: fc.bigInt({ min: 0n, max: 10n ** 17n }),
        day: int(0, 29),
      }),
      { maxLength: 25 },
    )
    .map((rows) =>
      rows.map((r, i) =>
        buildLedgerEntry({
          accountId: 'acct',
          metric: r.metric,
          quantity: r.quantity,
          unit: r.metric === 'delivery_bytes' ? 'byte' : 'byte_second',
          sourceId: `src_${i}`,
          eventTime: new Date(periodStart.getTime() + r.day * 86_400_000),
          period,
          rateVersion: 1,
        }),
      ),
    );

  const exportAt = (
    entries: readonly LedgerEntry[],
    day: number,
    exported: Record<string, bigint>,
  ) =>
    buildMeterEvents({
      stripeCustomerId: 'cus',
      accountId: 'acct',
      plan: pro,
      windowEnd: new Date(periodStart.getTime() + day * 86_400_000),
      entries,
      exported,
    });

  it('is deterministic under shuffling and duplicated rows (replay-safe)', () => {
    fc.assert(
      fc.property(entriesArb, int(0, 30), (entries, day) => {
        const a = exportAt(entries, day, {});
        const b = exportAt([...entries, ...entries].reverse(), day, {});
        expect(b).toEqual(a);
      }),
    );
  });

  it('daily cumulative exports sum to a single end-of-period export', () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        let cursors: Record<string, bigint> = {};
        const totals = new Map<string, bigint>();
        for (let day = 0; day <= 30; day++) {
          const result = exportAt(entries, day, cursors);
          for (const e of result.events) {
            expect(BigInt(e.payload.value) > 0n).toBe(true);
            totals.set(e.event_name, (totals.get(e.event_name) ?? 0n) + BigInt(e.payload.value));
          }
          cursors = result.cursors;
        }
        const once = exportAt(entries, 30, {});
        const onceTotals = new Map(once.events.map((e) => [e.event_name, BigInt(e.payload.value)]));
        expect(totals).toEqual(onceTotals);
        // re-running the last window after committing cursors emits nothing new
        expect(exportAt(entries, 30, cursors).events).toEqual([]);
      }),
    );
  });
});
