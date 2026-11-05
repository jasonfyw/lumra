import { BILLING_POLICY_V1, BYTES_PER_GB, MICRO_USD_PER_USD } from '@lumra/config';

/**
 * Integer unit arithmetic (ADR-004). Representation rules:
 *
 * - Money is integer micro-USD as a JS `number`, always asserted `Number.isSafeInteger`.
 *   (2^53 micro-USD ≈ $9 billion, far beyond any single account.)
 * - Byte-seconds and micro-unit quantities are `bigint`: 1 TB held for a month is 2.6e18
 *   byte-seconds, which exceeds 2^53.
 * - Bytes are accepted as `number` (safe integer) or `bigint`.
 * - Intermediate products are always computed in `bigint`; nothing touches floating point.
 *
 * Rounding: every division that can leave a remainder rounds **half up** (inputs are never
 * negative, so half up = half away from zero). See ADR-004 for why not banker's rounding.
 */

/** Micro-units per unit, used for GB-month and GB quantities and for USD. */
export const MICRO = 1_000_000n;
export const BYTES_PER_GB_N = BigInt(BYTES_PER_GB);
export const MICRO_USD_PER_USD_N = BigInt(MICRO_USD_PER_USD);
/** 1 cent = 10 000 micro-USD. */
export const MICRO_USD_PER_CENT = 10_000n;

export class BillingArithmeticError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'BillingArithmeticError';
  }
}

/** Converts a non-negative safe integer `number` or a non-negative `bigint` to `bigint`. */
export function toNonNegativeBigInt(value: number | bigint, label = 'value'): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new BillingArithmeticError(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingArithmeticError(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

/** Narrows a `bigint` to a safe-integer `number`, throwing instead of losing precision. */
export function toSafeNumber(value: bigint, label = 'value'): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BillingArithmeticError(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

/** floor((2n + d) / 2d): n / d rounded half up, for n ≥ 0 and d > 0. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new BillingArithmeticError('divisor must be positive');
  if (n < 0n) throw new BillingArithmeticError('dividend must be non-negative');
  return (2n * n + d) / (2n * d);
}

/** ceil(n / d), for n ≥ 0 and d > 0. Used only for conservative (upper-bound) projections. */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new BillingArithmeticError('divisor must be positive');
  if (n < 0n) throw new BillingArithmeticError('dividend must be non-negative');
  return (n + d - 1n) / d;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Micro GB-months for a byte-second total: byteSeconds × 1e6 / (1e9 × secondsPerBillingMonth),
 * rounded half up. With the v1 30-day convention the divisor is 2 592 000 000.
 */
export function storageGbMonthMicroUnits(
  byteSeconds: bigint,
  secondsPerBillingMonth: number = BILLING_POLICY_V1.secondsPerBillingMonth,
): bigint {
  const seconds = toNonNegativeBigInt(secondsPerBillingMonth, 'secondsPerBillingMonth');
  if (seconds === 0n) throw new BillingArithmeticError('secondsPerBillingMonth must be positive');
  return divRoundHalfUp(
    toNonNegativeBigInt(byteSeconds, 'byteSeconds') * MICRO,
    BYTES_PER_GB_N * seconds,
  );
}

/** Micro GB (= kilobytes, decimal) for a byte count, rounded half up. */
export function bytesToGbMicroUnits(bytes: number | bigint): bigint {
  return divRoundHalfUp(toNonNegativeBigInt(bytes, 'bytes') * MICRO, BYTES_PER_GB_N);
}

/**
 * Stripe minor units (USD cents) for a micro-USD amount, rounded half up
 * (e.g. 4 205 000 µ$ → 421 ¢, 4 204 999 µ$ → 420 ¢).
 */
export function microUsdToCents(microUsd: number | bigint): number {
  return toSafeNumber(
    divRoundHalfUp(toNonNegativeBigInt(microUsd, 'microUsd'), MICRO_USD_PER_CENT),
  );
}
