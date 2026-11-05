import { BillingArithmeticError, divRoundHalfUp, toNonNegativeBigInt, toSafeNumber } from './units';

/**
 * A change in an account's stored bytes (originals + derivatives + archives, PRD §5.2 FR-G07).
 * `delta` events add/subtract bytes; `snapshot` events set the absolute level (e.g. a
 * reconciliation against R2 listings). Snapshots are preferred: they cannot drift.
 */
export type StorageEvent =
  { type: 'delta'; at: Date; bytes: number } | { type: 'snapshot'; at: Date; storedBytes: number };

export interface StorageIntegration {
  /** Exact byte-seconds within [periodStart, periodEnd), rounded half up from byte-milliseconds. */
  byteSeconds: bigint;
  /** Stored bytes at `periodEnd`; the next period's opening level. */
  closingStoredBytes: number;
  /** Highest stored-byte level observed inside the period (including the opening level). */
  peakStoredBytes: number;
}

function epochMs(date: Date, label: string): bigint {
  const ms = date.getTime();
  if (!Number.isSafeInteger(ms)) throw new BillingArithmeticError(`${label} is not a valid date`);
  return BigInt(ms);
}

/**
 * Integrates stored bytes over `[periodStart, periodEnd)`.
 *
 * The level starts at `openingStoredBytes` (the level in force at or before the first event).
 * Events before `periodStart` adjust the opening level without contributing usage; events at or
 * after `periodEnd` are ignored. Events are sorted by time (stable, so same-instant events apply
 * in input order). Integration is exact in byte-milliseconds (`bigint`), converted once to
 * byte-seconds with half-up rounding, so the result is independent of how the timeline is split
 * up to that single rounding step (≤ 0.5 byte-second).
 *
 * Throws if the level would go negative (a lost or duplicated event upstream).
 */
export function integrateStorage(
  events: readonly StorageEvent[],
  periodStart: Date,
  periodEnd: Date,
  openingStoredBytes = 0,
): StorageIntegration {
  const start = epochMs(periodStart, 'periodStart');
  const end = epochMs(periodEnd, 'periodEnd');
  if (end < start) throw new BillingArithmeticError('periodEnd precedes periodStart');

  let level = toNonNegativeBigInt(openingStoredBytes, 'openingStoredBytes');
  const sorted = events
    .map((event, index) => ({ event, index, at: epochMs(event.at, 'event.at') }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1));

  let cursor = start;
  let byteMs = 0n;
  let peak = 0n;
  let started = false;

  const apply = (event: StorageEvent): void => {
    if (event.type === 'snapshot') {
      level = toNonNegativeBigInt(event.storedBytes, 'storedBytes');
    } else {
      if (!Number.isSafeInteger(event.bytes)) {
        throw new BillingArithmeticError('delta bytes must be a safe integer');
      }
      level += BigInt(event.bytes);
      if (level < 0n) throw new BillingArithmeticError('stored bytes went negative');
    }
  };

  for (const { event, at } of sorted) {
    if (at >= end) break;
    if (at <= start) {
      apply(event);
      continue;
    }
    if (!started) {
      peak = level;
      started = true;
    }
    byteMs += level * (at - cursor);
    cursor = at;
    apply(event);
    if (level > peak) peak = level;
  }
  if (!started) peak = level;
  byteMs += level * (end - cursor);

  return {
    byteSeconds: divRoundHalfUp(byteMs, 1000n),
    closingStoredBytes: toSafeNumber(level, 'closingStoredBytes'),
    peakStoredBytes: toSafeNumber(peak, 'peakStoredBytes'),
  };
}
