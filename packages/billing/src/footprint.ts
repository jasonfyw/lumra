import { STORAGE_ESTIMATE } from '@lumra/config';
import { divCeil, toNonNegativeBigInt, toSafeNumber } from './units';

export interface FootprintEstimateOptions {
  derivativeOverheadBps: number;
  derivativePerItemBytes: number;
}

/**
 * Conservative stored-bytes estimate for originals plus their not-yet-generated derivatives
 * (FR-G07 "1 GB total originals+derivatives", T10/T28). Linear in its inputs, so it can be applied
 * to per-item values or to aggregates (`SUM(byte_size)`, `COUNT(*)`) alike:
 *
 *   originalBytes + ceil(originalBytes × overheadBps / 10 000) + items × perItemBytes
 *
 * See `STORAGE_ESTIMATE` in @lumra/config for the chosen constants and their rationale.
 */
export function estimateStoredFootprintBytes(
  input: { originalBytes: number; items: number },
  options: FootprintEstimateOptions = STORAGE_ESTIMATE,
): number {
  const bytes = toNonNegativeBigInt(input.originalBytes, 'originalBytes');
  const items = toNonNegativeBigInt(input.items, 'items');
  const bps = toNonNegativeBigInt(options.derivativeOverheadBps, 'derivativeOverheadBps');
  const perItem = toNonNegativeBigInt(options.derivativePerItemBytes, 'derivativePerItemBytes');
  return toSafeNumber(bytes + divCeil(bytes * bps, 10_000n) + items * perItem, 'footprint');
}
