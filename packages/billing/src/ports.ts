import type { PlanId, PlanRates } from '@lumra/config';
import type { BillingAccountState } from './account';
import type { Reservation } from './admission';
import type { LedgerEntry, UsageMetric } from './ledger';
import type { StripeMeterEvent } from './meters';

/**
 * Persistence ports. The pure functions in this package take plain values; these interfaces
 * describe what the adapters must supply. Postgres implementations live in `@lumra/db`
 * (`createBillingStores`, T27); `MeterExportStore` is implemented with the Stripe export (T31).
 */

export interface PlanStore {
  /**
   * Rates for a plan at a specific rate version (`plan_rate_versions`; v1 seeded from
   * `RATE_CARD_V1`). Throws if the version does not exist.
   */
  getRates(planId: PlanId, rateVersion: number): Promise<PlanRates>;
  /** The plan's current version (`plans.rate_version`). */
  getCurrent(planId: PlanId): Promise<PlanRates>;
}

export interface UsageLedgerStore {
  /** INSERT … ON CONFLICT (metric, source_id) DO NOTHING; returns false for a duplicate. */
  appendIfAbsent(entry: LedgerEntry): Promise<boolean>;
  /** Batch form of `appendIfAbsent` in one statement; returns the number of new rows. */
  appendMany(entries: readonly LedgerEntry[]): Promise<number>;
  /** Period-to-date totals per metric, in raw ledger units. */
  totals(accountId: string, periodStart: Date): Promise<Record<UsageMetric, bigint>>;
  /** Rows for an export run, up to and including `until`. */
  list(accountId: string, periodStart: Date, until: Date): Promise<LedgerEntry[]>;
}

export interface BillingAccountStore {
  /** `null` when the user has no billing account (it is created with the auth user). */
  get(accountId: string): Promise<
    | (BillingAccountState & {
        accountId: string;
        planId: PlanId;
        rateVersion: number;
        stripeCustomerId: string | null;
        spendCapMicroUsd: number | null;
        warningThresholdsPct: readonly number[];
        /** Stored subscription period, `null` until T30 sets one (calendar month applies). */
        billingPeriodStart: Date | null;
        billingPeriodEnd: Date | null;
      })
    | null
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
