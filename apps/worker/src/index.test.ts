import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  OUTBOX_RELAY_CRON,
  createWorker,
  handlers,
  retryDelaySeconds,
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

describe('queue consumer', () => {
  it('registers the media.uploaded handler (T12)', () => {
    expect(handlers['media.uploaded']).toBeTypeOf('function');
  });

  it('acks poison messages instead of retrying forever', async () => {
    const msg = fakeMessage({ type: 'nope' });
    await worker.queue(batchOf(msg), env, ctx);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({
      level: 'error',
      service: 'worker',
      msg: 'invalid queue message',
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
    expect(events()[0]).toMatchObject({
      msg: 'processing',
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

  it('retries messages with no registered handler with a fixed delay (→ DLQ, no hot loop)', async () => {
    const msg = fakeMessage({
      type: 'media.delete',
      mediaId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
      traceId: 'req-3',
      dedupeKey: 'media.delete:0b6f',
    });
    expect(handlers['media.delete']).toBeUndefined();
    await worker.queue(batchOf(msg), env, ctx);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({ level: 'warn', traceId: 'req-3' });
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
      close,
    } as Services;
    return { services, outbox, close };
  }

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

  it('ignores other crons (T13)', async () => {
    const { services, outbox } = fakeServices(1);
    const w = createWorker({ createServices: () => services });
    await w.scheduled({ cron: '*/15 * * * *' } as ScheduledController, {} as Env);
    expect(outbox.claim).not.toHaveBeenCalled();
  });
});
