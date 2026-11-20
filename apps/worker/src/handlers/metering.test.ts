import { RATE_CARD_V1 } from '@lumra/config';
import type { AccountBillingContext, StorageAccrualCandidate } from '@lumra/db';
import type { LedgerEntry } from '@lumra/billing';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import { accrualWindowEnd, runStorageAccrual, type StorageAccrualDeps } from './metering';

const OWNER = '11111111-1111-4111-8111-111111111111';

const proContext: AccountBillingContext = {
  accountId: OWNER,
  account: { billingPeriodStart: null, billingPeriodEnd: null },
  plan: RATE_CARD_V1.pro,
};

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
