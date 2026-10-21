import { describe, expect, it, vi } from 'vitest';
import worker, { handlers, type Env } from './index';

function fakeMessage(body: unknown) {
  return { id: 'm1', body, attempts: 1, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
}

function batchOf(...messages: ReturnType<typeof fakeMessage>[]) {
  return {
    queue: 'lumra-jobs-dev',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

describe('queue consumer', () => {
  const env = {} as Env;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});

  it('acks poison messages instead of retrying forever', async () => {
    const msg = fakeMessage({ type: 'nope' });
    await worker.queue(batchOf(msg), env);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('dispatches valid messages to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    handlers['media.uploaded'] = handler;
    const msg = fakeMessage({
      type: 'media.uploaded',
      mediaId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      traceId: 'req-1',
      dedupeKey: 'media.uploaded:9a8b7c6d',
    });
    await worker.queue(batchOf(msg), env);
    expect(handler).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalled();
    delete handlers['media.uploaded'];
  });

  it('retries with backoff when a handler throws', async () => {
    handlers['gallery.delete'] = vi.fn().mockRejectedValue(new Error('boom'));
    const msg = fakeMessage({
      type: 'gallery.delete',
      galleryId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
      traceId: 'req-2',
      dedupeKey: 'gallery.delete:0b6f',
    });
    await worker.queue(batchOf(msg), env);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    delete handlers['gallery.delete'];
  });
});
