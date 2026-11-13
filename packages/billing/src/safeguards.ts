import type { PlanRates } from '@lumra/config';
import { effectiveCapMicroUsd } from './admission';
import { estimateOverageMicroUsd, planBillsOverage } from './rating';
import { newAlertThresholds } from './spend';
import type { BillingPeriod } from './usage-summary';

/**
 * Spend-cap alert runner (PRD §9.4, T32), shared by the worker (hourly sweep, after storage
 * accrual) and the web app (after a webhook changes the plan, or the owner changes the cap).
 * The cap only covers storage overage: uploads that would exceed it are refused at admission
 * (`checkAdmission`); delivery is neither metered nor capped (ADR-008). Persistence lives in
 * `@lumra/db` (`createBillingStateRepository`).
 */

/** One account's inputs (period = the one containing `now`). */
export interface SafeguardContext {
  accountId: string;
  plan: PlanRates;
  spendCapMicroUsd: number | null;
  warningThresholdsPct: number[];
  period: BillingPeriod;
  usage: { storageByteSecondsToDate: bigint };
  /** Spend-cap alert thresholds already recorded for this period (T32 dedupe). */
  alertsSent: number[];
}

/** An `email.send` outbox row; `dedupeKey` makes it once-only. */
export interface EmailNotice {
  template: string;
  dedupeKey: string;
  data?: Record<string, string | number>;
}

export interface SafeguardStore {
  safeguardContexts(accountIds: readonly string[], now: Date): Promise<SafeguardContext[]>;
  /**
   * Records spend-cap alerts once per (account, period, threshold) and enqueues one
   * `spend_cap_alert` email per newly recorded threshold. Returns the thresholds recorded now.
   */
  recordSpendAlerts(
    accountId: string,
    periodStart: Date,
    thresholdsPct: number[],
    details: { spendMicroUsd: number; capMicroUsd: number; traceId: string },
  ): Promise<number[]>;
}

export interface SafeguardResult {
  evaluated: number;
  /** Spend-cap alert thresholds recorded in this run (T32). */
  alerts: number;
}

export async function evaluateBillingSafeguards(
  accountIds: readonly string[],
  deps: { store: SafeguardStore; now: Date; traceId: string },
): Promise<SafeguardResult> {
  const result: SafeguardResult = { evaluated: 0, alerts: 0 };
  if (accountIds.length === 0) return result;
  const contexts = await deps.store.safeguardContexts(accountIds, deps.now);
  for (const ctx of contexts) {
    result.evaluated++;
    // Spend-cap alerts at 50/80/100 % (PRD §9.4), deduped per period and threshold.
    const cap = planBillsOverage(ctx.plan)
      ? effectiveCapMicroUsd(ctx.plan, ctx.spendCapMicroUsd)
      : null;
    if (cap === null) continue;
    const spend = estimateOverageMicroUsd(
      { storageByteSeconds: ctx.usage.storageByteSecondsToDate },
      ctx.plan,
    );
    const due = newAlertThresholds(spend, cap, ctx.warningThresholdsPct, ctx.alertsSent);
    if (due.length === 0) continue;
    const recorded = await deps.store.recordSpendAlerts(ctx.accountId, ctx.period.start, due, {
      spendMicroUsd: spend,
      capMicroUsd: cap,
      traceId: deps.traceId,
    });
    result.alerts += recorded.length;
  }
  return result;
}
