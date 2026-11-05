import { describe, expect, it, vi } from 'vitest';
import worker, {
  OUTBOX_RELAY_CRON,
  createWorker,
  handlers,
  retryDelaySeconds,
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

function withHandler(type: keyof typeof handlers, handler: JobHandler, fn: () => Promise<void>) {
  const previous = handlers[type];
  handlers[type] = handler;
  return fn().finally(() => {
    if (previous) handlers[type] = previous;
    else delete handlers[type];
  });
}

describe('queue consumer', () => {
  const env = {} as Env;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});

  it('registers the media.uploaded handler', () => {
    expect(handlers['media.uploaded']).toBeTypeOf('function');
  });

  it('acks poison messages instead of retrying forever', async () => {
    const msg = fakeMessage({ type: 'nope' });
    await worker.queue(batchOf(msg), env);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('dispatches valid messages to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const msg = fakeMessage({
      type: 'media.uploaded',
      mediaId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      traceId: 'req-1',
      dedupeKey: 'media.uploaded:9a8b7c6d',
    });
    await withHandler('media.uploaded', handler, () => worker.queue(batchOf(msg), env));
    expect(handler).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('retries with exponential backoff when a handler throws', async () => {
    const msg = fakeMessage(
      {
        type: 'gallery.delete',
        galleryId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
        traceId: 'req-2',
        dedupeKey: 'gallery.delete:0b6f',
      },
      3,
    );
    await withHandler('gallery.delete', vi.fn().mockRejectedValue(new Error('boom')), () =>
      worker.queue(batchOf(msg), env),
    );
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 80 });
    expect(retryDelaySeconds(1)).toBe(20);
    expect(retryDelaySeconds(10)).toBe(900);
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
