import {
  accountPeriodKey,
  billingPeriodAt,
  planStorageAccrual,
  rateDeliveryEvents,
  type DeliveryEvent,
  type UsageLedgerStore,
} from '@lumra/billing';
import type { DeliveryServedMessage } from '@lumra/contracts';
import type { BillingRepository } from '@lumra/db';
import type { Logger } from '../log';

/**
 * Usage metering jobs (T27, ADR-004). Thin I/O shells: every rule (periods, rounding, estimated
 * cost, idempotency keys) lives in `@lumra/billing`; persistence in `@lumra/db`.
 */

// ---------------------------------------------------------------------------------------------
// Delivery bytes: `delivery.served` events from the media gateway (`lumra-usage-*` queue)
// ---------------------------------------------------------------------------------------------

export interface DeliveryIngestDeps {
  repo: Pick<BillingRepository, 'galleryOwners' | 'accountContexts' | 'deliveryTotals'>;
  ledger: Pick<UsageLedgerStore, 'appendMany'>;
  log: Logger;
}

export interface DeliveryIngestResult {
  received: number;
  /** New ledger rows. */
  inserted: number;
  /** Rows already in the ledger (redelivered or retried gateway sends). */
  duplicates: number;
  /** Galleries without an owner (guest drafts): no billing account to meter against. */
  skippedGuest: number;
  /** Gallery rows that no longer exist. */
  skippedUnknownGallery: number;
  /** Owners without a billing account (should not happen: created with the auth user). */
  skippedNoAccount: number;
  /** Accounts that got new ledger rows: the delivery safety cutoff re-evaluates them (T28). */
  accountIds: string[];
}

/**
 * Appends one `delivery_bytes` row per gateway response. Idempotent: the source id is the
 * event's `dedupeKey` and the ledger's UNIQUE (metric, source_id) drops redeliveries, so the
 * queue can retry the whole batch after any failure. Throws on DB errors (→ batch retry).
 */
export async function ingestDeliveryEvents(
  messages: readonly DeliveryServedMessage[],
  deps: DeliveryIngestDeps,
): Promise<DeliveryIngestResult> {
  const result: DeliveryIngestResult = {
    received: messages.length,
    inserted: 0,
    duplicates: 0,
    skippedGuest: 0,
    skippedUnknownGallery: 0,
    skippedNoAccount: 0,
    accountIds: [],
  };
  if (messages.length === 0) return result;

  const owners = await deps.repo.galleryOwners(messages.map((m) => m.galleryId));
  const owned: { message: DeliveryServedMessage; accountId: string }[] = [];
  for (const message of messages) {
    if (!owners.has(message.galleryId)) result.skippedUnknownGallery++;
    else {
      const accountId = owners.get(message.galleryId);
      if (accountId) owned.push({ message, accountId });
      else result.skippedGuest++;
    }
  }
  if (owned.length === 0) return result;

  const accounts = await deps.repo.accountContexts(owned.map((o) => o.accountId));
  const events: DeliveryEvent[] = [];
  const pairs = new Map<string, { accountId: string; periodStart: Date }>();
  for (const { message, accountId } of owned) {
    const ctx = accounts.get(accountId);
    if (!ctx) {
      result.skippedNoAccount++;
      continue;
    }
    const servedAt = new Date(message.servedAt);
    const { start } = billingPeriodAt(ctx.account, servedAt);
    pairs.set(accountPeriodKey(accountId, start), { accountId, periodStart: start });
    events.push({ sourceId: message.dedupeKey, accountId, bytes: message.bytes, servedAt });
  }
  if (events.length === 0) return result;

  const totals = await deps.repo.deliveryTotals([...pairs.values()]);
  const entries = rateDeliveryEvents({
    events,
    accounts,
    deliveryBytesToDate: (accountId, periodStart) =>
      totals.get(accountPeriodKey(accountId, periodStart)) ?? 0n,
  });
  result.inserted = await deps.ledger.appendMany(entries);
  result.duplicates = entries.length - result.inserted;
  if (result.inserted > 0) result.accountIds = [...new Set(entries.map((e) => e.accountId))];
  return result;
}

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
