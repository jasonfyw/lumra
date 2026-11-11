import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_CARD_V1 } from '@lumra/config';
import { DEADLINES } from './deadline';
import worker, {
  DELETION_SWEEP_CRON,
  OUTBOX_RELAY_CRON,
  RELAY_KICK_PATH,
  STORAGE_ACCRUAL_CRON,
  createWorker,
  isUsageQueue,
  handlers,
  retryDelaySeconds,
  timeoutRetryDelaySeconds,
  sentryOptions,
  type Env,
  type JobHandler,
} from './index';
import type { Services } from './services';

function fakeMessage(body: unknown, attempts = 1) {
  return { id: 'm1', body, attempts, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
}

function batchOf(...messages: ReturnType<typeof fakeMessage>[]) {
  return {
    queue: 'lumra-jobs-dev',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
const env = {} as Env;
let lines: string[] = [];
const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  lines = [];
  const push = (line: unknown) => void lines.push(String(line));
  vi.spyOn(console, 'error').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'info').mockImplementation(push);
});
afterEach(() => vi.restoreAllMocks());

async function withHandler(
  type: keyof typeof handlers,
  handler: JobHandler,
  fn: () => Promise<void>,
) {
  const previous = handlers[type];
  handlers[type] = handler;
  try {
    await fn();
  } finally {
    if (previous) handlers[type] = previous;
    else delete handlers[type];
  }
}

function fakeServices(claimBatches: number) {
  let remaining = claimBatches;
  const outbox = {
    claim: vi.fn(async () =>
      remaining-- > 0
        ? [
            {
              id: `row-${remaining}`,
              eventName: 'media.uploaded',
              aggregateId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
              payload: { mediaId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
              dedupeKey: null,
              attemptCount: 0,
            },
          ]
        : [],
    ),
    markPublished: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  };
  const close = vi.fn(async () => {});
  const services = {
    outboxRepo: () => outbox,
    mediaRepo: () => {
      throw new Error('unused');
    },
    processor: () => {
      throw new Error('unused');
    },
    accessStateRepo: () => {
      throw new Error('unused');
    },
    billingRepo: () => {
      throw new Error('unused');
    },
    deletionRepo: () => {
      throw new Error('unused');
    },
    close,
  } as Services;
  return { services, outbox, close };
}

describe('queue consumer', () => {
  it('registers the media.uploaded handler (T12)', () => {
    expect(handlers['media.uploaded']).toBeTypeOf('function');
  });

  it('acks poison messages instead of retrying forever', async () => {
    const msg = fakeMessage({ type: 'nope' });
    await worker.queue(batchOf(msg), env, ctx);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'invalid queue message')).toMatchObject({
      level: 'error',
      service: 'worker',
    });
  });

  it('dispatches valid messages to the registered handler with a trace-bound logger', async () => {
    const handler = vi.fn().mockImplementation(async (_m, { log }) => log.info('processing'));
    const msg = fakeMessage({
      type: 'media.uploaded',
      mediaId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      traceId: 'req-1',
      dedupeKey: 'media.uploaded:9a8b7c6d',
    });
    await withHandler('media.uploaded', handler, () => worker.queue(batchOf(msg), env, ctx));
    expect(handler).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'processing')).toMatchObject({
      traceId: 'req-1',
      type: 'media.uploaded',
    });
  });

  it('retries with backoff when a handler throws, logging the traceId without secrets', async () => {
    const msg = fakeMessage({
      type: 'gallery.delete',
      galleryId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
      traceId: 'req-2',
      dedupeKey: 'gallery.delete:0b6f',
    });
    await withHandler(
      'gallery.delete',
      vi
        .fn()
        .mockRejectedValue(
          new Error('db auth failed: postgres://svc:hunter2@db.internal/postgres'),
        ),
      () => worker.queue(batchOf(msg), env, ctx),
    );
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    const failed = events().find((e) => e.msg === 'job failed');
    expect(failed).toMatchObject({
      level: 'error',
      traceId: 'req-2',
      type: 'gallery.delete',
      attempt: 1,
    });
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(retryDelaySeconds(3)).toBe(80);
    expect(retryDelaySeconds(10)).toBe(900);
  });

  it('registers the deletion handlers (T13)', () => {
    expect(handlers['media.delete']).toBeTypeOf('function');
    expect(handlers['gallery.delete']).toBeTypeOf('function');
  });

  it('purges a media.delete message end to end and acks it', async () => {
    const mediaId = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
    const galleryId = '1c7f4d3f-9b62-4d2f-8e8b-3a5c6d7e8f90';
    const repo = {
      getMediaForPurge: vi.fn(async () => [
        {
          id: mediaId,
          galleryId,
          status: 'deleting',
          originalKey: `originals/owner-12345678/${galleryId}/${mediaId}/source`,
          mediaDeleted: true,
          galleryDeleted: false,
          variantKeys: [`derivatives/${galleryId}/${mediaId}/w640q80.webp`],
        },
      ]),
      markMediaDeleted: vi.fn(async (ids: string[]) => ids),
    };
    const { services } = fakeServices(0);
    services.deletionRepo = () => repo as unknown as ReturnType<Services['deletionRepo']>;
    const originals = { delete: vi.fn(async () => {}) };
    const derivatives = { delete: vi.fn(async () => {}) };
    const w = createWorker({ createServices: () => services });
    const msg = fakeMessage({
      type: 'media.delete',
      mediaId,
      traceId: 'req-9',
      dedupeKey: `media.delete:${mediaId}`,
    });
    await w.queue(
      batchOf(msg),
      { ORIGINALS: originals, DERIVATIVES: derivatives, ARCHIVES: {} } as unknown as Env,
      ctx,
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(originals.delete).toHaveBeenCalledWith([
      `originals/owner-12345678/${galleryId}/${mediaId}/source`,
    ]);
    expect(derivatives.delete).toHaveBeenCalledOnce();
    expect(repo.markMediaDeleted).toHaveBeenCalledWith([mediaId]);
    const finished = events().find((e) => e.msg === 'media purge finished');
    expect(finished).toMatchObject({ mediaId, purged: 1, objectKeys: 2 });
    // Logs carry ids and counts only, never object keys.
    expect(lines.join('\n')).not.toContain('originals/');
  });

  it('acks (drops) valid messages with no registered handler instead of retrying into the DLQ', async () => {
    const msg = fakeMessage({
      type: 'guest.expire',
      guestSessionId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
      traceId: 'req-3',
      dedupeKey: 'guest.expire:0b6f',
    });
    expect(handlers['guest.expire']).toBeUndefined();
    await worker.queue(batchOf(msg), env, ctx);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'no handler registered; message dropped')).toMatchObject({
      level: 'error',
      traceId: 'req-3',
      type: 'guest.expire',
      dedupeKey: 'guest.expire:0b6f',
    });
  });
});

describe('health', () => {
  it('serves a sanitized /health and nothing else', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/health', { headers: { 'x-request-id': 'probe-1' } }),
      { ...env, COMMIT_SHA: 'abcdef1234567890' },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('probe-1');
    expect(await res.json()).toEqual({ status: 'ok', service: 'worker', commit: 'abcdef123456' });

    const other = await worker.fetch(new Request('https://worker.test/admin'), env, ctx);
    expect(other.status).toBe(404);
  });
});

describe('sentry', () => {
  it('stays uninitialised without a DSN', () => {
    expect(sentryOptions(env)).toBeUndefined();
  });

  it('enables scrubbing options when a DSN is set', () => {
    const options = sentryOptions({
      ...env,
      SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1',
      COMMIT_SHA: 'abc1234',
    });
    expect(options).toMatchObject({ enabled: true, sendDefaultPii: false, release: 'abc1234' });
    expect(typeof options?.beforeSend).toBe('function');
  });
});

describe('scheduled outbox relay', () => {
  it('relays the outbox for the relay cron, polling until the window closes', async () => {
    const { services, close } = fakeServices(2);
    let clock = 0;
    const sendBatch = vi.fn(async () => {});
    const w = createWorker({
      createServices: () => services,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await w.scheduled(
      { cron: OUTBOX_RELAY_CRON } as ScheduledController,
      {
        JOBS: { sendBatch },
      } as unknown as Env,
    );
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalled();
    expect(clock).toBeGreaterThan(40_000);
  });

  it('runs the storage accrual for its hourly cron (T27) and closes the pool', async () => {
    const { services, outbox, close } = fakeServices(0);
    const repo = {
      storageAccrualCandidates: vi.fn(async () => []),
      storageByteSecondsToDate: vi.fn(),
      commitStorageAccrual: vi.fn(),
    };
    services.billingRepo = () => repo as unknown as ReturnType<Services['billingRepo']>;
    const w = createWorker({ createServices: () => services });
    await w.scheduled({ cron: STORAGE_ACCRUAL_CRON } as ScheduledController, {} as Env);
    expect(repo.storageAccrualCandidates).toHaveBeenCalledTimes(1);
    expect(outbox.claim).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(events().some((e) => e.msg === 'storage accrual finished')).toBe(true);
  });

  it('runs the deletion sweep on its */15 cron (T13) and closes the pool', async () => {
    const { services, outbox, close } = fakeServices(1);
    const repo = {
      listStuckGalleries: vi.fn(async () => []),
      listStuckMedia: vi.fn(async () => []),
    };
    services.deletionRepo = () => repo as unknown as ReturnType<Services['deletionRepo']>;
    const w = createWorker({
      createServices: () => services,
      now: () => Date.parse('2026-11-11T12:00:00Z'),
    });
    expect(DELETION_SWEEP_CRON).toBe('*/15 * * * *');
    const bucket = { delete: vi.fn(), list: vi.fn() };
    await w.scheduled(
      { cron: DELETION_SWEEP_CRON } as ScheduledController,
      {
        ORIGINALS: bucket,
        DERIVATIVES: bucket,
        ARCHIVES: bucket,
      } as unknown as Env,
    );
    expect(repo.listStuckGalleries).toHaveBeenCalledWith(new Date('2026-11-11T11:00:00Z'), 10);
    expect(repo.listStuckMedia).toHaveBeenCalledOnce();
    expect(outbox.claim).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'deletion sweep finished')).toMatchObject({
      galleries: 0,
      purged: 0,
    });
  });

  it('ignores the nightly cron for now (remaining T13 reconcilers)', async () => {
    const { services, outbox } = fakeServices(1);
    const w = createWorker({ createServices: () => services });
    await w.scheduled({ cron: '17 3 * * *' } as ScheduledController, {} as Env);
    expect(outbox.claim).not.toHaveBeenCalled();
  });
});

const mediaMessage = (id: string, n: number) =>
  ({
    ...fakeMessage({
      type: 'media.uploaded',
      mediaId: `9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6${n}`,
      traceId: `req-${n}`,
      dedupeKey: `media.uploaded:${n}`,
    }),
    id,
  }) as ReturnType<typeof fakeMessage>;

describe('concurrent batches', () => {
  it('runs jobs concurrently with distinct processor slots and acks each one', async () => {
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler: JobHandler = async (_m, { slot }) => {
      started.push(slot);
      if (started.length === 4) release();
      await gate; // resolves only once all four jobs are in flight
    };
    const messages = [1, 2, 3, 4].map((n) => mediaMessage(`m${n}`, n));
    const { services, close } = fakeServices(0);
    const w = createWorker({ createServices: () => services, random: () => 0.5 });
    await withHandler('media.uploaded', handler, () => w.queue(batchOf(...messages), env, ctx));
    expect(new Set(started)).toEqual(new Set([0, 1, 2, 3]));
    expect(started[0]).toBe(2); // offset from `random`
    for (const m of messages) expect(m.ack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('acks and retries messages of one batch independently', async () => {
    const handler: JobHandler = async (m) => {
      if (m.type === 'media.uploaded' && m.traceId === 'req-2') throw new Error('boom');
    };
    const ok = mediaMessage('ok', 1);
    const bad = mediaMessage('bad', 2);
    const poison = { ...fakeMessage({ type: 'nope' }), id: 'poison' };
    const { services } = fakeServices(0);
    const w = createWorker({ createServices: () => services });
    await withHandler('media.uploaded', handler, () => w.queue(batchOf(ok, bad, poison), env, ctx));
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(bad.ack).not.toHaveBeenCalled();
    expect(poison.ack).toHaveBeenCalledOnce();
  });
});

describe('job deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('uses short retry delays after a timeout', () => {
    expect([1, 2, 3, 4, 5, 9].map(timeoutRetryDelaySeconds)).toEqual([5, 15, 60, 180, 600, 600]);
  });

  it('retries a hung job after the job deadline with a short delay and logs a warning', async () => {
    vi.useFakeTimers();
    const hung: JobHandler = () => new Promise(() => {});
    const msg = mediaMessage('hung', 1);
    const { services } = fakeServices(0);
    const w = createWorker({ createServices: () => services });
    const done = withHandler('media.uploaded', hung, () => w.queue(batchOf(msg), env, ctx));
    await vi.advanceTimersByTimeAsync(DEADLINES.jobMs + 10);
    await done;
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'deadline exceeded')).toMatchObject({
      level: 'warn',
      step: 'job media.uploaded',
      retryInSeconds: 5,
    });
  });

  it('bounds each repository call, so a hung DB step fails the job early', async () => {
    vi.useFakeTimers();
    const msg = mediaMessage('db', 1);
    msg.attempts = 2;
    const { services } = fakeServices(0);
    services.mediaRepo = () =>
      ({ getForProcessing: () => new Promise(() => {}) }) as unknown as ReturnType<
        Services['mediaRepo']
      >;
    services.processor = () => ({ process: vi.fn() });
    const w = createWorker({ createServices: () => services });
    const r2 = { ORIGINALS: {}, DERIVATIVES: {} } as unknown as Env;
    const done = w.queue(batchOf(msg), { ...env, ...r2 }, ctx);
    await vi.advanceTimersByTimeAsync(DEADLINES.dbStepMs + 10);
    await done;
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(events().find((e) => e.msg === 'deadline exceeded')).toMatchObject({
      step: 'db.getForProcessing',
    });
  });
});

describe('relay kick endpoint', () => {
  const SECRET = 'kick-secret-0123456789abcdef0123456789abcdef';
  function kick(headers: Record<string, string> = {}, method = 'POST') {
    return new Request(`https://worker.test${RELAY_KICK_PATH}`, { method, headers });
  }
  function kickCtx() {
    const pending: Promise<unknown>[] = [];
    const c = {
      waitUntil: vi.fn((p: Promise<unknown>) => void pending.push(p)),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    return { c, settle: () => Promise.all(pending) };
  }

  it('fails closed with 503 when no secret is configured', async () => {
    const { services, outbox } = fakeServices(1);
    const w = createWorker({ createServices: () => services });
    const res = await w.fetch(kick({ authorization: `Bearer ${SECRET}` }), env, ctx);
    expect(res.status).toBe(503);
    expect(outbox.claim).not.toHaveBeenCalled();
  });

  it('rejects missing or wrong bearer tokens with 401', async () => {
    const { services, outbox } = fakeServices(1);
    const w = createWorker({ createServices: () => services });
    const e = { ...env, WORKER_KICK_SECRET: SECRET } as Env;
    for (const headers of [
      {} as Record<string, string>,
      { authorization: 'Bearer wrong' },
      { authorization: `Basic ${SECRET}` },
      { authorization: `Bearer ${SECRET}x` },
    ]) {
      const res = await w.fetch(kick(headers), e, ctx);
      expect(res.status).toBe(401);
    }
    expect(outbox.claim).not.toHaveBeenCalled();
    expect((await w.fetch(kick({}, 'GET'), e, ctx)).status).toBe(405);
  });

  it('accepts a valid kick with 202 and runs one bounded relay pass in waitUntil', async () => {
    const { services, outbox, close } = fakeServices(1);
    const sendBatch = vi.fn(async () => {});
    const w = createWorker({ createServices: () => services });
    const e = { ...env, WORKER_KICK_SECRET: SECRET, JOBS: { sendBatch } } as unknown as Env;
    const { c, settle } = kickCtx();
    const res = await w.fetch(kick({ authorization: `Bearer ${SECRET}` }), e, c);
    expect(res.status).toBe(202);
    await settle();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(outbox.markPublished).toHaveBeenCalledWith(['row-0']);
    expect(close).toHaveBeenCalled();
    expect(events().find((ev) => ev.msg === 'relay pass')).toMatchObject({
      source: 'kick',
      claimed: 1,
      published: 1,
    });
  });

  it('ignores a kick while a pass is already running in this isolate', async () => {
    const { services, outbox } = fakeServices(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sendBatch = vi.fn(() => gate);
    const w = createWorker({ createServices: () => services });
    const e = { ...env, WORKER_KICK_SECRET: SECRET, JOBS: { sendBatch } } as unknown as Env;
    const { c, settle } = kickCtx();
    const auth = { authorization: `Bearer ${SECRET}` };
    expect((await w.fetch(kick(auth), e, c)).status).toBe(202);
    const second = await w.fetch(kick(auth), e, c);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ status: 'already_running' });
    release();
    await settle();
    expect(outbox.claim).toHaveBeenCalledOnce(); // only the first kick ran a pass
  });
});

describe('usage queue (T27 delivery ingestion)', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const GALLERY = '22222222-2222-4222-8222-222222222222';
  const delivered = (dedupeKey: string) => ({
    type: 'delivery.served',
    galleryId: GALLERY,
    action: 'original',
    mediaId: '55555555-5555-4555-8555-555555555555',
    archivePartId: null,
    variant: 'original',
    bytes: 2048,
    servedAt: '2026-11-09T12:00:00.000Z',
    traceId: 'ray',
    dedupeKey,
  });

  function usageServices(appendMany: (rows: unknown[]) => Promise<number>) {
    const { services, close } = fakeServices(0);
    const repo = {
      galleryOwners: vi.fn(async () => new Map([[GALLERY, OWNER]])),
      accountContexts: vi.fn(
        async () =>
          new Map([
            [
              OWNER,
              {
                accountId: OWNER,
                account: { billingPeriodStart: null, billingPeriodEnd: null },
                plan: RATE_CARD_V1.pro,
              },
            ],
          ]),
      ),
      deliveryTotals: vi.fn(async () => new Map()),
      ledger: { appendMany: vi.fn(appendMany) },
    };
    services.billingRepo = () => repo as unknown as ReturnType<Services['billingRepo']>;
    return { services, repo, close };
  }

  const usageBatch = (...messages: ReturnType<typeof fakeMessage>[]) =>
    ({ ...batchOf(...messages), queue: 'lumra-usage' }) as unknown as MessageBatch<unknown>;

  it('recognises only the usage queues', () => {
    for (const q of ['lumra-usage', 'lumra-usage-dev', 'lumra-usage-staging']) {
      expect(isUsageQueue(q)).toBe(true);
    }
    for (const q of ['lumra-jobs', 'lumra-jobs-dev', 'lumra-usage-dlq', 'lumra-usage-x']) {
      expect(isUsageQueue(q)).toBe(false);
    }
  });

  it('ingests a batch in one ledger write and acks every message', async () => {
    const { services, repo, close } = usageServices(async (rows) => rows.length);
    const a = { ...fakeMessage(delivered('jti-a:0-2047')), id: 'a' };
    const b = { ...fakeMessage(delivered('jti-b:0-2047')), id: 'b' };
    const w = createWorker({ createServices: () => services });
    await w.queue(usageBatch(a, b), env, ctx);
    expect(repo.ledger.appendMany).toHaveBeenCalledTimes(1);
    expect(repo.ledger.appendMany.mock.calls[0]![0]).toHaveLength(2);
    expect(a.ack).toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(events().find((e) => e.msg === 'usage batch ingested')).toMatchObject({
      inserted: 2,
    });
  });

  it('acks malformed messages and retries the valid ones when the DB write fails', async () => {
    const { services } = usageServices(async () => {
      throw new Error('db down');
    });
    const bad = { ...fakeMessage({ type: 'delivery.served', bytes: -1 }), id: 'bad' };
    const good = { ...fakeMessage(delivered('jti-a:0-2047'), 2), id: 'good' };
    const w = createWorker({ createServices: () => services });
    await w.queue(usageBatch(bad, good), env, ctx);
    expect(bad.ack).toHaveBeenCalled();
    expect(good.ack).not.toHaveBeenCalled();
    expect(good.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(2) });
    const failure = events().find((e) => e.msg === 'usage batch failed');
    expect(failure).toBeDefined();
    // Never logs tokens or byte ranges from the dedupe key.
    expect(JSON.stringify(failure)).not.toContain('jti-a');
  });
});
