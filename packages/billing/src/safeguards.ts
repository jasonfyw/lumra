import type { PlanRates } from '@lumra/config';
import type { BillingAccountState } from './account';
import { checkDeliveryAllowance } from './admission';
import { type DeliveryPauseReason, deliveryPauseFor } from './delivery-pause';
import type { BillingPeriod } from './usage-summary';

/**
 * Delivery safety cutoff runner (PRD §9.4, T28/T32), shared by the worker (after every delivery
 * batch and in the hourly sweep) and the web app (after a webhook changes the plan, or the owner
 * changes the cap). The decision is `checkDeliveryAllowance`; this only compares it with the
 * persisted pause and asks the store to flip it. Persistence lives in `@lumra/db`
 * (`createBillingStateRepository`).
 */

/** One account's inputs for `checkDeliveryAllowance` (period = the one containing `now`). */
export interface SafeguardContext {
  accountId: string;
  plan: PlanRates;
  account: BillingAccountState;
  spendCapMicroUsd: number | null;
  warningThresholdsPct: number[];
  deliveryPausedReason: DeliveryPauseReason | null;
  period: BillingPeriod;
  usage: { storageByteSecondsToDate: bigint; deliveryBytesToDate: number };
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
   * Compare-and-set of `delivery_paused_reason` from `expected` to `next`; in the same
   * transaction the owner's published galleries are re-synced to KV and `notice` is enqueued.
   * Returns false (writing nothing) when another writer changed it first.
   */
  setDeliveryPause(
    accountId: string,
    expected: DeliveryPauseReason | null,
    next: DeliveryPauseReason | null,
    options: { traceId: string; notice?: EmailNotice },
  ): Promise<boolean>;
}

export interface SafeguardChange {
  accountId: string;
  /** New pause reason, or null when delivery resumed. */
  paused: DeliveryPauseReason | null;
}

export interface SafeguardResult {
  evaluated: number;
  paused: number;
  resumed: number;
  /** Another writer moved the pause first; the next evaluation converges. */
  conflicts: number;
  changes: SafeguardChange[];
}

export async function evaluateBillingSafeguards(
  accountIds: readonly string[],
  deps: { store: SafeguardStore; now: Date; traceId: string },
): Promise<SafeguardResult> {
  const result: SafeguardResult = {
    evaluated: 0,
    paused: 0,
    resumed: 0,
    conflicts: 0,
    changes: [],
  };
  if (accountIds.length === 0) return result;
  const contexts = await deps.store.safeguardContexts(accountIds, deps.now);
  for (const ctx of contexts) {
    result.evaluated++;
    const decision = checkDeliveryAllowance({
      plan: ctx.plan,
      account: ctx.account,
      now: deps.now,
      usage: ctx.usage,
      capMicroUsd: ctx.spendCapMicroUsd,
    });
    const next = deliveryPauseFor(decision);
    if (next === ctx.deliveryPausedReason) continue;
    const notice: EmailNotice | undefined = next
      ? {
          template: 'delivery_paused',
          dedupeKey: `email:delivery_paused:${ctx.accountId}:${ctx.period.start.toISOString()}:${next}`,
          data: { reason: next, periodEnd: ctx.period.end.toISOString() },
        }
      : undefined;
    const changed = await deps.store.setDeliveryPause(
      ctx.accountId,
      ctx.deliveryPausedReason,
      next,
      {
        traceId: deps.traceId,
        ...(notice ? { notice } : {}),
      },
    );
    if (!changed) {
      result.conflicts++;
      continue;
    }
    if (next) result.paused++;
    else result.resumed++;
    result.changes.push({ accountId: ctx.accountId, paused: next });
  }
  return result;
}
