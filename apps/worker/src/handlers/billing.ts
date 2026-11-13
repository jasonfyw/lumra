import {
  evaluateBillingSafeguards as evaluateSafeguards,
  fitsFreeCaps,
  sweepBillingAccount,
  type BillingNotice,
  type EmailNotice,
  type PlanStore,
  type SafeguardResult,
} from '@lumra/billing';
import type { EmailSendMessage } from '@lumra/contracts';
import type { BillingStateRepository } from '@lumra/db';
import type { Logger } from '../log';

/**
 * Billing safeguards and maintenance (T28/T32/T33). Thin I/O shells around `@lumra/billing`:
 *
 * - `evaluateBillingSafeguards` runs in the hourly sweep and records spend-cap alerts (50/80/100 %
 *   of the cap, storage overage only). Delivery is not metered, capped or paused (ADR-008); the
 *   spending cap is enforced at upload admission.
 * - `runBillingSweep` (hourly) persists time-based transitions — `past_due` → `restricted` when
 *   the grace ends, `canceled` → `free` once the account fits the Free caps.
 */

export interface SafeguardDeps {
  repo: Pick<BillingStateRepository, 'safeguardContexts' | 'recordSpendAlerts'>;
  log: Logger;
  now: () => Date;
  traceId: string;
}

export type { SafeguardResult };

export async function evaluateBillingSafeguards(
  accountIds: readonly string[],
  deps: SafeguardDeps,
): Promise<SafeguardResult> {
  const result = await evaluateSafeguards(accountIds, {
    store: deps.repo,
    now: deps.now(),
    traceId: deps.traceId,
  });
  if (result.alerts > 0) deps.log.info('spend-cap alerts recorded', { alerts: result.alerts });
  return result;
}

export interface BillingSweepDeps extends SafeguardDeps {
  repo: BillingStateRepository;
  plans: Pick<PlanStore, 'getCurrent'>;
  batchSize?: number;
}

export interface BillingSweepResult {
  scanned: number;
  restricted: number;
  freed: number;
  conflicts: number;
  safeguards: SafeguardResult;
}

/** Notice → once-only email key: one per account and transition instant. */
export function noticeFor(notice: BillingNotice, accountId: string, at: Date): EmailNotice {
  return {
    template: notice satisfies EmailSendMessage['template'],
    dedupeKey: `email:${notice}:${accountId}:${at.toISOString()}`,
  };
}

export async function runBillingSweep(deps: BillingSweepDeps): Promise<BillingSweepResult> {
  const now = deps.now();
  const free = await deps.plans.getCurrent('free');
  const batchSize = deps.batchSize ?? 200;
  const result: BillingSweepResult = {
    scanned: 0,
    restricted: 0,
    freed: 0,
    conflicts: 0,
    safeguards: { evaluated: 0, alerts: 0 },
  };
  let after: string | null = null;
  while (true) {
    const page = await deps.repo.sweepCandidates(after, batchSize);
    if (page.length === 0) break;
    const reevaluate: string[] = [];
    for (const c of page) {
      result.scanned++;
      const decision = sweepBillingAccount(c, now, { fitsFreeCaps: fitsFreeCaps(free, c) });
      if (decision.kind === 'update') {
        const at = decision.restrictedSince ?? now;
        const ok = await deps.repo.applySweep(c.accountId, c.status, decision, {
          traceId: deps.traceId,
          notices: decision.notices.map((n) => noticeFor(n, c.accountId, at)),
        });
        if (!ok) result.conflicts++;
        else if (decision.status === 'restricted') result.restricted++;
        else if (decision.status === 'free') result.freed++;
      }
      reevaluate.push(c.accountId);
    }
    const safeguards = await evaluateBillingSafeguards(reevaluate, deps);
    result.safeguards.evaluated += safeguards.evaluated;
    result.safeguards.alerts += safeguards.alerts;
    after = page[page.length - 1]!.accountId;
    if (page.length < batchSize) break;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// email.send
// ---------------------------------------------------------------------------------------------

export type EmailOutcome = 'skipped_unconfigured';

/**
 * `email.send` (transition notices, spend-cap alerts). Lumra has no transactional email provider
 * for application mail yet: Supabase sends auth mail through its own SMTP (Resend, PLAN §5 #3),
 * which this Worker cannot use. Until a provider is wired (TODO: RESEND_API_KEY + a verified
 * sending domain, then render `template` and look up the account's email by `accountId`), the
 * message is acknowledged and logged without personal data. The notice is still visible in the
 * app: `/account` derives its banners from the billing state and the recorded alerts.
 */
export async function handleEmailSend(
  message: EmailSendMessage,
  deps: { log: Logger },
): Promise<EmailOutcome> {
  deps.log.info('email not sent: no email provider configured', {
    template: message.template,
    accountId: message.accountId,
  });
  return 'skipped_unconfigured';
}
