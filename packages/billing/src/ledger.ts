import { z } from 'zod';
import { BillingArithmeticError, toNonNegativeBigInt } from './units';

/**
 * Usage ledger rows (PRD §8 `usage_ledger`). The ledger is append-only and authoritative;
 * Stripe meter events are derived from it (ADR-004). Storage is the only metered quantity:
 * delivery (served bytes) is not tracked or billed (ADR-008).
 *
 * `quantity` maps to `usage_ledger.quantity_micro_units BIGINT` and holds the exact integer
 * quantity in the row's `unit` (byte-seconds). Conversion to billing micro-units
 * (micro GB-month) happens only when rating or exporting, so ingestion never rounds.
 */
export const USAGE_METRICS = ['storage_byte_seconds'] as const;
export const usageMetricSchema = z.enum(USAGE_METRICS);
export type UsageMetric = z.infer<typeof usageMetricSchema>;

export const USAGE_UNITS = ['byte_second'] as const;
export const usageUnitSchema = z.enum(USAGE_UNITS);
export type UsageUnit = z.infer<typeof usageUnitSchema>;

export const METRIC_UNIT: Readonly<Record<UsageMetric, UsageUnit>> = {
  storage_byte_seconds: 'byte_second',
};

export const ledgerEntrySchema = z
  .object({
    /** Deterministic: `${metric}:${sourceId}`, backing UNIQUE (metric, source_id). */
    idempotencyKey: z.string().min(1),
    accountId: z.string().min(1),
    metric: usageMetricSchema,
    quantity: z.bigint().nonnegative(),
    unit: usageUnitSchema,
    sourceId: z.string().min(1).max(200),
    eventTime: z.date(),
    periodStart: z.date(),
    rateVersion: z.number().int().positive(),
    estimatedCostMicroUsd: z.number().int().nonnegative(),
  })
  .refine((e) => METRIC_UNIT[e.metric] === e.unit, { message: 'unit does not match metric' })
  .refine((e) => e.idempotencyKey === ledgerIdempotencyKey(e.metric, e.sourceId), {
    message: 'idempotencyKey must equal metric:sourceId',
  });
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export function ledgerIdempotencyKey(metric: UsageMetric, sourceId: string): string {
  return `${metric}:${sourceId}`;
}

/**
 * Source id for a storage integration window. Windows must not overlap for an account, so the
 * (account, window) pair is a natural idempotency key: re-running the integration job for the
 * same window yields the same row and is rejected by the UNIQUE constraint.
 */
export function storageWindowSourceId(
  accountId: string,
  windowStart: Date,
  windowEnd: Date,
): string {
  return `${accountId}:${windowStart.toISOString()}/${windowEnd.toISOString()}`;
}

export class LedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerEntryError';
  }
}

export interface BuildLedgerEntryInput {
  accountId: string;
  metric: UsageMetric;
  quantity: number | bigint;
  unit: UsageUnit;
  /** `storageWindowSourceId(...)` for storage. */
  sourceId: string;
  eventTime: Date;
  period: { start: Date; end: Date };
  rateVersion: number;
  estimatedCostMicroUsd?: number;
}

/** Validates and normalises a ledger row. Same input always yields the same row. */
export function buildLedgerEntry(input: BuildLedgerEntryInput): LedgerEntry {
  let quantity: bigint;
  try {
    quantity = toNonNegativeBigInt(input.quantity, 'quantity');
  } catch (error) {
    if (error instanceof BillingArithmeticError) throw new LedgerEntryError(error.message);
    throw error;
  }
  const t = input.eventTime.getTime();
  if (!(input.period.start.getTime() <= t && t <= input.period.end.getTime())) {
    throw new LedgerEntryError('eventTime outside billing period');
  }
  const parsed = ledgerEntrySchema.safeParse({
    idempotencyKey: ledgerIdempotencyKey(input.metric, input.sourceId),
    accountId: input.accountId,
    metric: input.metric,
    quantity,
    unit: input.unit,
    sourceId: input.sourceId,
    eventTime: new Date(t),
    periodStart: new Date(input.period.start.getTime()),
    rateVersion: input.rateVersion,
    estimatedCostMicroUsd: input.estimatedCostMicroUsd ?? 0,
  });
  if (!parsed.success) {
    throw new LedgerEntryError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  return parsed.data;
}

/** Sums quantities per metric, ignoring duplicate idempotency keys (as the DB UNIQUE would). */
export function sumLedger(entries: readonly LedgerEntry[]): Record<UsageMetric, bigint> {
  const seen = new Set<string>();
  const totals: Record<UsageMetric, bigint> = { storage_byte_seconds: 0n };
  for (const entry of entries) {
    if (seen.has(entry.idempotencyKey)) continue;
    seen.add(entry.idempotencyKey);
    totals[entry.metric] += entry.quantity;
  }
  return totals;
}
