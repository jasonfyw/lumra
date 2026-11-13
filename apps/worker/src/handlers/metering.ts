import { billingPeriodAt, planStorageAccrual } from '@lumra/billing';
import type { BillingRepository } from '@lumra/db';
import type { Logger } from '../log';

/**
 * Usage metering job (T27, ADR-004): storage accrual only — delivery is not metered (ADR-008).
 * Thin I/O shell: every rule (periods, rounding, estimated cost, idempotency keys) lives in
 * `@lumra/billing`; persistence in `@lumra/db`.
 */

// ---------------------------------------------------------------------------------------------
// Storage GB-month accrual (cron)
// ---------------------------------------------------------------------------------------------

export interface StorageAccrualDeps {
  repo: Pick<
    BillingRepository,
    'storageAccrualCandidates' | 'storageByteSecondsToDate' | 'commitStorageAccrual'
  >;
  log: Logger;
  now: () => number;
  /** Stop starting new accounts after this much wall time (ms). */
  budgetMs: number;
  batchSize?: number;
}

export interface StorageAccrualResult {
  accounts: number;
  initialized: number;
  rows: number;
  /** Cursor moved by another run in between (its window is skipped here, never doubled). */
  conflicts: number;
  failed: number;
  /** Candidates left for the next run because the budget ran out. */
  incomplete: boolean;
}

/** Window ends are whole minutes, so retried runs in the same minute reuse the same window. */
export function accrualWindowEnd(nowMs: number): Date {
  return new Date(Math.floor(nowMs / 60_000) * 60_000);
}

/**
 * Accrues `storage_byte_seconds` for every account whose cursor is behind the current minute,
 * stalest first. Each account commits on its own (rows + cursor in one transaction); a failing
 * account is logged and left for the next run without blocking the others.
 */
export async function runStorageAccrual(deps: StorageAccrualDeps): Promise<StorageAccrualResult> {
  const started = deps.now();
  const windowEnd = accrualWindowEnd(started);
  const batchSize = deps.batchSize ?? 100;
  const seen = new Set<string>();
  const result: StorageAccrualResult = {
    accounts: 0,
    initialized: 0,
    rows: 0,
    conflicts: 0,
    failed: 0,
    incomplete: false,
  };

  while (true) {
    if (deps.now() - started >= deps.budgetMs) {
      result.incomplete = true;
      break;
    }
    // Failed accounts stay behind the window; ask for enough rows to get past them.
    const candidates = (
      await deps.repo.storageAccrualCandidates(windowEnd, batchSize + seen.size)
    ).filter((c) => !seen.has(c.accountId));
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      if (deps.now() - started >= deps.budgetMs) {
        result.incomplete = true;
        break;
      }
      seen.add(candidate.accountId);
      try {
        const toDate = candidate.cursor
          ? await deps.repo.storageByteSecondsToDate(
              candidate.accountId,
              billingPeriodAt(candidate.account, candidate.cursor.accruedThrough).start,
            )
          : 0n;
        const accrual = planStorageAccrual({
          accountId: candidate.accountId,
          account: candidate.account,
          plan: candidate.plan,
          cursor: candidate.cursor,
          storedBytesNow: candidate.storedBytesNow,
          windowEnd,
          byteSecondsToDate: toDate,
        });
        if (!accrual) continue;
        const committed = await deps.repo.commitStorageAccrual(
          candidate.accountId,
          candidate.cursor?.accruedThrough ?? null,
          accrual.entries,
          accrual.nextCursor,
        );
        if (!committed) {
          result.conflicts++;
          continue;
        }
        result.accounts++;
        result.rows += accrual.entries.length;
        if (!candidate.cursor) result.initialized++;
      } catch (error) {
        result.failed++;
        // Account ids are internal UUIDs (not personal data); no bytes or filenames are logged.
        deps.log.error('storage accrual failed for account', {
          accountId: candidate.accountId,
          err: error,
        });
      }
    }
    if (result.incomplete || candidates.length < batchSize) break;
  }
  return result;
}
