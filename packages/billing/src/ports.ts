import type { PlanId, PlanRates } from '@lumra/config';
import type { BillingAccountState } from './account';
import type { Reservation } from './admission';
import type { LedgerEntry, UsageMetric } from './ledger';
import type { StripeMeterEvent } from './meters';

/**
 * Persistence ports for the DB layer (T02 schema, T28/T31/T32 adapters). The pure functions in
 * this package take plain values; these interfaces describe what the adapters must supply.
 */

export interface PlanStore {
  /** Rates for a plan at a specific rate version (`plans` table; seeded from `RATE_CARD_V1`). */
  getRates(planId: PlanId, rateVersion: number): Promise<PlanRates>;
}

export interface UsageLedgerStore {
  /** INSERT … ON CONFLICT (metric, source_id) DO NOTHING; returns false for a duplicate. */
  appendIfAbsent(entry: LedgerEntry): Promise<boolean>;
  /** Period-to-date totals per metric, in raw ledger units. */
  totals(accountId: string, periodStart: Date): Promise<Record<UsageMetric, bigint>>;
  /** Rows for an export run, up to and including `until`. */
  list(accountId: string, periodStart: Date, until: Date): Promise<LedgerEntry[]>;
}

export interface BillingAccountStore {
  get(accountId: string): Promise<
    BillingAccountState & {
      accountId: string;
      planId: PlanId;
      rateVersion: number;
      stripeCustomerId: string | null;
      spendCapMicroUsd: number | null;
      warningThresholdsPct: readonly number[];
      periodStart: Date;
      periodEnd: Date;
    }
  >;
}

export interface CostReservationStore {
  /** Pending upload/archive reservations that have not settled into the ledger yet. */
  pending(accountId: string): Promise<Reservation[]>;
}

export interface MeterExportStore {
  /** Cumulative exported meter units keyed by `meterCursorKey`. */
  cursors(accountId: string): Promise<Record<string, bigint>>;
  /**
   * Atomically stores the built events and new cursors (`billing_exports`) *before* sending,
   * so retries resend the stored payload with the same identifiers.
   */
  record(
    accountId: string,
    events: StripeMeterEvent[],
    cursors: Record<string, bigint>,
  ): Promise<void>;
}
