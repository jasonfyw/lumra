import { RATE_CARD_V1 } from '@lumra/config';
import type { DeliveryServedMessage } from '@lumra/contracts';
import type { AccountBillingContext, StorageAccrualCandidate } from '@lumra/db';
import type { LedgerEntry } from '@lumra/billing';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import {
  accrualWindowEnd,
  ingestDeliveryEvents,
  runStorageAccrual,
  type DeliveryIngestDeps,
  type StorageAccrualDeps,
} from './metering';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OWNED_GALLERY = '22222222-2222-4222-8222-222222222222';
const GUEST_GALLERY = '33333333-3333-4333-8333-333333333333';
const GONE_GALLERY = '44444444-4444-4444-8444-444444444444';

function delivery(galleryId: string, dedupeKey: string, bytes = 1000): DeliveryServedMessage {
  return {
    type: 'delivery.served',
    galleryId,
    action: 'preview',
    mediaId: '55555555-5555-4555-8555-555555555555',
    archivePartId: null,
    variant: 'w640',
    bytes,
    servedAt: '2026-11-09T12:00:00.000Z',
    traceId: 'ray-1',
    dedupeKey,
  };
}

const proContext: AccountBillingContext = {
  accountId: OWNER,
  account: { billingPeriodStart: null, billingPeriodEnd: null },
  plan: RATE_CARD_V1.pro,
};

/** In-memory ledger with the DB's UNIQUE (metric, source_id) semantics. */
function memoryLedger() {
  const rows = new Map<string, LedgerEntry>();
  return {
    rows,
    appendMany: vi.fn(async (entries: readonly LedgerEntry[]) => {
      let added = 0;
      for (const e of entries) {
        if (rows.has(e.idempotencyKey)) continue;
        rows.set(e.idempotencyKey, e);
        added++;
      }
      return added;
    }),
  };
}

function ingestDeps(ledger = memoryLedger()): DeliveryIngestDeps & { ledger: typeof ledger } {
  return {
    repo: {
      galleryOwners: vi.fn(
        async () =>
          new Map<string, string | null>([
            [OWNED_GALLERY, OWNER],
            [GUEST_GALLERY, null],
          ]),
      ),
      accountContexts: vi.fn(async () => new Map([[OWNER, proContext]])),
      deliveryTotals: vi.fn(async () => new Map<string, bigint>()),
    },
    ledger,
    log: silentLogger,
  };
}

describe('ingestDeliveryEvents', () => {
  it('writes one delivery_bytes row per owned-gallery event, attributed to the owner', async () => {
    const deps = ingestDeps();
    const result = await ingestDeliveryEvents(
      [
        delivery(OWNED_GALLERY, 'jti-a:0-999'),
        delivery(GUEST_GALLERY, 'jti-b:0-999'),
        delivery(GONE_GALLERY, 'jti-c:0-999'),
      ],
      deps,
    );
    expect(result).toEqual({
      received: 3,
      inserted: 1,
      duplicates: 0,
      skippedGuest: 1,
      skippedUnknownGallery: 1,
      skippedNoAccount: 0,
    });
    const [row] = [...deps.ledger.rows.values()];
    expect(row).toMatchObject({
      accountId: OWNER,
      metric: 'delivery_bytes',
      quantity: 1000n,
      sourceId: 'jti-a:0-999',
      periodStart: new Date('2026-11-01T00:00:00Z'),
      rateVersion: 1,
    });
    expect(deps.repo.deliveryTotals).toHaveBeenCalledWith([
      { accountId: OWNER, periodStart: new Date('2026-11-01T00:00:00Z') },
    ]);
  });

  it('is idempotent: a redelivered batch adds nothing (no double billing)', async () => {
    const ledger = memoryLedger();
    const batch = [delivery(OWNED_GALLERY, 'jti-a:0-999'), delivery(OWNED_GALLERY, 'jti-a:0-999')];
    const first = await ingestDeliveryEvents(batch, ingestDeps(ledger));
    const second = await ingestDeliveryEvents(batch, ingestDeps(ledger));
    expect(first.inserted).toBe(1);
    expect(second).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(ledger.rows.size).toBe(1);
  });

  it('counts legitimate repeated downloads (distinct tokens/ranges) separately', async () => {
    const deps = ingestDeps();
    await ingestDeliveryEvents(
      [
        delivery(OWNED_GALLERY, 'jti-a:0-999'),
        delivery(OWNED_GALLERY, 'jti-b:0-999'),
        delivery(OWNED_GALLERY, 'jti-a:1000-1999'),
      ],
      deps,
    );
    expect(deps.ledger.rows.size).toBe(3);
  });

  it('skips owners without a billing account and touches no ledger when nothing is billable', async () => {
    const deps = ingestDeps();
    deps.repo.accountContexts = vi.fn(async () => new Map());
    const result = await ingestDeliveryEvents([delivery(OWNED_GALLERY, 'k')], deps);
    expect(result.skippedNoAccount).toBe(1);
    expect(deps.ledger.appendMany).not.toHaveBeenCalled();
  });

  it('propagates DB failures so the queue retries the batch', async () => {
    const deps = ingestDeps();
    deps.ledger.appendMany.mockRejectedValueOnce(new Error('db down'));
    await expect(ingestDeliveryEvents([delivery(OWNED_GALLERY, 'k')], deps)).rejects.toThrow(
      'db down',
    );
  });
});

describe('runStorageAccrual', () => {
  const GB = 1_000_000_000;
  const now = Date.parse('2026-11-09T13:07:42Z');

  function candidate(overrides: Partial<StorageAccrualCandidate> = {}): StorageAccrualCandidate {
    return {
      ...proContext,
      cursor: { accruedThrough: new Date('2026-11-09T12:07:00Z'), storedBytes: GB },
      storedBytesNow: 2 * GB,
      ...overrides,
    };
  }

  function accrualDeps(candidates: StorageAccrualCandidate[]) {
    const pending = new Map(candidates.map((c) => [c.accountId, c]));
    const commits: { accountId: string; entries: readonly LedgerEntry[] }[] = [];
    const repo = {
      storageAccrualCandidates: vi.fn(async () => [...pending.values()]),
      storageByteSecondsToDate: vi.fn(async () => 0n),
      commitStorageAccrual: vi.fn(
        async (accountId: string, _expected: Date | null, entries: readonly LedgerEntry[]) => {
          pending.delete(accountId);
          commits.push({ accountId, entries });
          return true;
        },
      ),
    };
    const deps: StorageAccrualDeps = {
      repo,
      log: silentLogger,
      now: () => now,
      budgetMs: 50_000,
      batchSize: 10,
    };
    return { deps, repo, commits };
  }

  it('truncates the window end to the minute', () => {
    expect(accrualWindowEnd(now)).toEqual(new Date('2026-11-09T13:07:00Z'));
  });

  it('accrues the held level since the cursor and moves the cursor to the window end', async () => {
    const { deps, repo, commits } = accrualDeps([candidate()]);
    const result = await runStorageAccrual(deps);
    expect(result).toMatchObject({ accounts: 1, rows: 1, conflicts: 0, failed: 0 });
    expect(commits[0]!.entries[0]!.quantity).toBe(BigInt(GB) * 3600n);
    expect(repo.commitStorageAccrual).toHaveBeenCalledWith(
      OWNER,
      new Date('2026-11-09T12:07:00Z'),
      expect.any(Array),
      { accruedThrough: new Date('2026-11-09T13:07:00Z'), storedBytes: 2 * GB },
    );
  });

  it('initialises a missing cursor without writing ledger rows', async () => {
    const { deps, repo } = accrualDeps([candidate({ cursor: null })]);
    const result = await runStorageAccrual(deps);
    expect(result).toMatchObject({ accounts: 1, initialized: 1, rows: 0 });
    expect(repo.storageByteSecondsToDate).not.toHaveBeenCalled();
    expect(repo.commitStorageAccrual).toHaveBeenCalledWith(OWNER, null, [], expect.anything());
  });

  it('counts a lost optimistic-lock race as a conflict, not a second accrual', async () => {
    const { deps, repo } = accrualDeps([candidate()]);
    repo.commitStorageAccrual.mockImplementationOnce(async () => {
      repo.storageAccrualCandidates.mockResolvedValue([]);
      return false;
    });
    const result = await runStorageAccrual(deps);
    expect(result).toMatchObject({ accounts: 0, conflicts: 1 });
  });

  it('logs a failing account and continues with the others; never loops on it', async () => {
    const other = candidate({ accountId: '66666666-6666-4666-8666-666666666666' });
    const { deps, repo } = accrualDeps([candidate(), other]);
    repo.storageByteSecondsToDate.mockRejectedValueOnce(new Error('boom'));
    const result = await runStorageAccrual(deps);
    expect(result).toMatchObject({ accounts: 1, failed: 1 });
    expect(repo.storageAccrualCandidates.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('stops at the time budget and reports the run as incomplete', async () => {
    const { deps } = accrualDeps([candidate()]);
    let t = now;
    const result = await runStorageAccrual({ ...deps, now: () => (t += 60_000) });
    expect(result.incomplete).toBe(true);
  });
});
