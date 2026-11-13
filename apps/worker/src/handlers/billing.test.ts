import { BILLING_POLICY_V1, RATE_CARD_V1 } from '@lumra/config';
import type { BillingStateRepository, SweepCandidate } from '@lumra/db';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import { handleEmailSend, noticeFor, runBillingSweep } from './billing';

const DAY = 86_400_000;
const now = new Date('2026-11-20T12:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function candidate(n: number, over: Partial<SweepCandidate>): SweepCandidate {
  return {
    accountId: id(n),
    status: 'free',
    pastDueSince: null,
    restrictedSince: null,
    canceledAt: null,
    deliveryPausedReason: null,
    activeGalleries: 1,
    storedBytes: 0,
    ...over,
  };
}

function fakeRepo(pages: SweepCandidate[][]) {
  const applied: unknown[][] = [];
  const repo = {
    sweepCandidates: vi.fn(async () => pages.shift() ?? []),
    applySweep: vi.fn(async (...args: unknown[]) => {
      applied.push(args);
      return true;
    }),
    safeguardContexts: vi.fn(async () => []),
    setDeliveryPause: vi.fn(async () => true),
  } as unknown as BillingStateRepository;
  return { repo, applied };
}

describe('runBillingSweep (T33)', () => {
  it('restricts past_due after the grace, frees canceled accounts that fit, re-evaluates all', async () => {
    const graceOver = new Date(now.getTime() - 8 * DAY);
    const { repo, applied } = fakeRepo([
      [
        candidate(1, { status: 'past_due', pastDueSince: graceOver }),
        candidate(2, { status: 'past_due', pastDueSince: new Date(now.getTime() - DAY) }),
        candidate(3, { status: 'canceled', canceledAt: graceOver, activeGalleries: 2 }),
        candidate(4, { status: 'canceled', canceledAt: graceOver, activeGalleries: 5 }),
      ],
    ]);
    const result = await runBillingSweep({
      repo,
      plans: { getCurrent: async () => RATE_CARD_V1.free },
      log: silentLogger,
      now: () => now,
      traceId: 'cron',
      batchSize: 10,
    });
    expect(result).toMatchObject({ scanned: 4, restricted: 1, freed: 1, conflicts: 0 });
    const suspendedAt = new Date(graceOver.getTime() + BILLING_POLICY_V1.pastDueGraceMs);
    expect(applied[0]).toEqual([
      id(1),
      'past_due',
      expect.objectContaining({ status: 'restricted', restrictedSince: suspendedAt }),
      {
        traceId: 'cron',
        notices: [noticeFor('delivery_suspended', id(1), suspendedAt)],
      },
    ]);
    expect(applied[1]).toEqual([
      id(3),
      'canceled',
      expect.objectContaining({ status: 'free' }),
      { traceId: 'cron', notices: [] },
    ]);
    expect(repo.safeguardContexts).toHaveBeenCalledWith([id(1), id(2), id(3), id(4)], now);
  });

  it('pages through candidates by id', async () => {
    const { repo } = fakeRepo([[candidate(1, {}), candidate(2, {})], [candidate(3, {})]]);
    const result = await runBillingSweep({
      repo,
      plans: { getCurrent: async () => RATE_CARD_V1.free },
      log: silentLogger,
      now: () => now,
      traceId: 'cron',
      batchSize: 2,
    });
    expect(result.scanned).toBe(3);
    expect(repo.sweepCandidates).toHaveBeenNthCalledWith(2, id(2), 2);
  });

  it('notice dedupe keys are stable per transition instant', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    expect(noticeFor('payment_failed', id(1), at)).toEqual(noticeFor('payment_failed', id(1), at));
    expect(noticeFor('payment_failed', id(1), at).dedupeKey).toBe(
      `email:payment_failed:${id(1)}:2026-11-01T00:00:00.000Z`,
    );
  });
});

describe('email.send', () => {
  it('acks and logs without personal data while no provider is configured', async () => {
    const info = vi.fn();
    const outcome = await handleEmailSend(
      {
        type: 'email.send',
        accountId: id(1),
        template: 'payment_failed',
        data: {},
        traceId: 't',
        dedupeKey: 'd',
      },
      { log: { ...silentLogger, info } as unknown as typeof silentLogger },
    );
    expect(outcome).toBe('skipped_unconfigured');
    expect(info).toHaveBeenCalledWith('email not sent: no email provider configured', {
      template: 'payment_failed',
      accountId: id(1),
    });
  });
});
