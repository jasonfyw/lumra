import { describe, expect, it, vi } from 'vitest';
import type { OutboxRepository, OutboxRow } from '@lumra/db';
import { silentLogger } from './log';
import { outboxRetryDelaySeconds, relayOutbox } from './outbox-relay';

const mediaId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function row(id: string, overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id,
    eventName: 'media.uploaded',
    aggregateId: mediaId,
    payload: { mediaId, traceId: `req-${id}` },
    dedupeKey: `media.uploaded:${id}`,
    attemptCount: 0,
    ...overrides,
  };
}

function fakeRepo(rows: OutboxRow[]) {
  const pending = [...rows];
  const repo = {
    claim: vi.fn(async (limit: number) => pending.splice(0, limit)),
    markPublished: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  } satisfies OutboxRepository;
  return repo;
}

describe('relayOutbox', () => {
  it('publishes claimed rows with their dedupe keys and marks them processed', async () => {
    const repo = fakeRepo([row('a'), row('b')]);
    const queue = { sendBatch: vi.fn(async () => {}) };
    const result = await relayOutbox(repo, queue, silentLogger);
    expect(result).toEqual({ published: 2, failed: 0 });
    expect(queue.sendBatch).toHaveBeenCalledWith([
      {
        body: { type: 'media.uploaded', mediaId, traceId: 'req-a', dedupeKey: 'media.uploaded:a' },
        contentType: 'json',
      },
      {
        body: { type: 'media.uploaded', mediaId, traceId: 'req-b', dedupeKey: 'media.uploaded:b' },
        contentType: 'json',
      },
    ]);
    expect(repo.markPublished).toHaveBeenCalledWith(['a', 'b']);
  });

  it('drains in batches until a short batch', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`));
    const repo = fakeRepo(rows);
    const queue = { sendBatch: vi.fn(async () => {}) };
    const result = await relayOutbox(repo, queue, silentLogger, { batchSize: 2 });
    expect(result.published).toBe(5);
    expect(queue.sendBatch).toHaveBeenCalledTimes(3);
  });

  it('records failures with backoff when the queue rejects the batch', async () => {
    const repo = fakeRepo([row('a', { attemptCount: 2 })]);
    const queue = { sendBatch: vi.fn(async () => Promise.reject(new Error('queue down'))) };
    const result = await relayOutbox(repo, queue, silentLogger);
    expect(result).toEqual({ published: 0, failed: 1 });
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith('a', 'publish failed: queue down', 40);
  });

  it('parks malformed rows instead of publishing them', async () => {
    const repo = fakeRepo([row('bad', { payload: { mediaId: 'nope' } }), row('ok')]);
    const queue = { sendBatch: vi.fn(async () => {}) };
    const result = await relayOutbox(repo, queue, silentLogger);
    expect(result).toEqual({ published: 1, failed: 1 });
    expect(repo.markFailed).toHaveBeenCalledWith('bad', 'invalid outbox payload', 3600);
    expect(repo.markPublished).toHaveBeenCalledWith(['ok']);
  });

  it('caps retry backoff at one hour', () => {
    expect(outboxRetryDelaySeconds(0)).toBe(10);
    expect(outboxRetryDelaySeconds(3)).toBe(80);
    expect(outboxRetryDelaySeconds(30)).toBe(3600);
  });
});
