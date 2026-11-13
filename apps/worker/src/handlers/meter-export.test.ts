import { buildLedgerEntry, type LedgerEntry, type StripeMeterEvent } from '@lumra/billing';
import { BYTES_PER_GB, RATE_CARD_V1, STRIPE_API_VERSION } from '@lumra/config';
import type { MeterExportRepository, StoredMeterExport } from '@lumra/db';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import { exportWindowEnd, runMeterExport, stripeMeterSender } from './meter-export';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const periodStart = new Date('2026-11-04T09:30:00Z');
const periodEnd = new Date('2026-12-04T09:30:00Z');

function delivery(sourceId: string, bytes: number, at: Date): LedgerEntry {
  return buildLedgerEntry({
    accountId: ACCOUNT,
    metric: 'delivery_bytes',
    quantity: bytes,
    unit: 'byte',
    sourceId,
    eventTime: at,
    period: { start: periodStart, end: periodEnd },
    rateVersion: 1,
  });
}

/** In-memory MeterExportRepository with the same semantics as the Postgres adapter. */
function memoryRepo(entries: LedgerEntry[]) {
  const cursors: Record<string, bigint> = {};
  const exports = new Map<string, StoredMeterExport & { sent: boolean }>();
  const repo: MeterExportRepository = {
    exportPeriods: async () => [
      { accountId: ACCOUNT, stripeCustomerId: 'cus_1', periodStart, periodEnd },
    ],
    ledgerFor: async (_a, _p, until) => entries.filter((e) => e.eventTime <= until),
    cursors: async () => ({ ...cursors }),
    recordExport: async (_a, events, previous, next) => {
      for (const [k, v] of Object.entries(previous)) if (cursors[k] !== v) return false;
      Object.assign(cursors, next);
      for (const { event } of events) {
        if (!exports.has(event.identifier)) {
          exports.set(event.identifier, {
            id: event.identifier,
            accountId: ACCOUNT,
            identifier: event.identifier,
            attemptCount: 0,
            event,
            sent: false,
          });
        }
      }
      return true;
    },
    unsent: async () => [...exports.values()].filter((e) => !e.sent),
    markSent: async (id) => {
      exports.get(id)!.sent = true;
    },
    markFailed: async (id) => {
      exports.get(id)!.attemptCount++;
    },
  };
  return { repo, cursors, exports };
}

const plans = { getRates: async () => RATE_CARD_V1.pro };

describe('runMeterExport (T31)', () => {
  it('re-running the export produces no duplicate meter events', async () => {
    const day = (d: number) => new Date(periodStart.getTime() + d * 86_400_000);
    const entries = [
      delivery('a', 5 * BYTES_PER_GB + 250_000_000, day(1)),
      delivery('b', 500_000_000, day(2)),
    ];
    const { repo } = memoryRepo(entries);
    const sent: StripeMeterEvent[] = [];
    const send = vi.fn(async (e: StripeMeterEvent) => {
      sent.push(e);
      return { ok: true as const };
    });
    const run = (d: number) =>
      runMeterExport({ repo, plans, send, log: silentLogger, now: () => day(d), mode: 'daily' });

    expect(await run(1.5)).toMatchObject({ recorded: 1, sent: 1 });
    expect(await run(1.6)).toMatchObject({ recorded: 0, sent: 0 }); // same window: nothing new
    expect(await run(2.5)).toMatchObject({ recorded: 1, sent: 1 });
    expect(await run(3.5)).toMatchObject({ recorded: 0, sent: 0 });
    expect(sent.map((e) => [e.event_name, e.payload.value])).toEqual([
      ['lumra_delivery_overage', '250'],
      ['lumra_delivery_overage', '500'],
    ]);
    expect(new Set(sent.map((e) => e.identifier)).size).toBe(2);
  });

  it('a failed send is retried with the stored payload, not a recomputed one', async () => {
    const now = new Date(periodStart.getTime() + 2 * 86_400_000);
    const entries = [delivery('a', 6 * BYTES_PER_GB, new Date(now.getTime() - 3_600_000))];
    const { repo } = memoryRepo(entries);
    const bodies: string[] = [];
    let fail = true;
    const send = async (e: StripeMeterEvent) => {
      bodies.push(JSON.stringify(e));
      if (fail) return { ok: false as const, permanent: false, error: 'http_500' };
      return { ok: true as const };
    };
    const deps = { repo, plans, send, log: silentLogger, now: () => now, mode: 'daily' as const };
    expect(await runMeterExport(deps)).toMatchObject({ recorded: 1, sendFailed: 1 });
    entries.push(delivery('late', 1_000_000_000, new Date(now.getTime() - 60_000)));
    fail = false;
    const second = await runMeterExport(deps);
    expect(second.sent).toBe(1);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('skips everything without a Stripe key', async () => {
    const { repo } = memoryRepo([]);
    const spy = vi.spyOn(repo, 'exportPeriods');
    expect(
      await runMeterExport({
        repo,
        plans,
        send: null,
        log: silentLogger,
        now: () => periodEnd,
        mode: 'daily',
      }),
    ).toMatchObject({ skipped: 'unconfigured' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('window ends are whole hours', () => {
    expect(exportWindowEnd(new Date('2026-11-13T10:59:59Z'))).toEqual(
      new Date('2026-11-13T10:00:00Z'),
    );
  });
});

describe('stripeMeterSender', () => {
  const event: StripeMeterEvent = {
    event_name: 'lumra_delivery_overage',
    identifier: `${ACCOUNT}:delivery_bytes:1:2`,
    timestamp: 2,
    payload: { stripe_customer_id: 'cus_1', value: '250' },
  };

  it('posts the form with the identifier as Idempotency-Key and the pinned version', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const send = stripeMeterSender('sk_test_x', fetchImpl as unknown as typeof fetch);
    expect(await send(event)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/billing/meter_events');
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(event.identifier);
    expect(headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(String(init.body)).toContain('payload%5Bvalue%5D=250');
  });

  it('classifies failures: 4xx permanent, 429/5xx/network retryable', async () => {
    const respond = (status: number, code?: string) =>
      stripeMeterSender(
        'sk',
        (async () =>
          new Response(JSON.stringify({ error: { code } }), { status })) as unknown as typeof fetch,
      );
    expect(await respond(400, 'timestamp_too_far_in_past')(event)).toEqual({
      ok: false,
      permanent: true,
      error: 'timestamp_too_far_in_past',
    });
    expect(await respond(429)(event)).toMatchObject({ ok: false, permanent: false });
    expect(await respond(503)(event)).toMatchObject({ ok: false, permanent: false });
    const offline = stripeMeterSender('sk', (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch);
    expect(await offline(event)).toEqual({ ok: false, permanent: false, error: 'TypeError' });
  });
});
