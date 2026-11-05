import { outboxRowToQueueMessage, type QueueMessage } from '@lumra/contracts';
import type { OutboxRepository } from '@lumra/db';
import type { Logger } from './log';

export interface QueueProducer {
  sendBatch(messages: Iterable<{ body: QueueMessage; contentType?: 'json' }>): Promise<unknown>;
}

export interface RelayOptions {
  /** Rows claimed per batch (Queues `sendBatch` accepts at most 100 messages). */
  batchSize?: number;
  /** Stop after this many batches in one pass so a backlog can't exceed the invocation budget. */
  maxBatches?: number;
  /** How long a claimed row stays invisible to other relays while we publish it. */
  leaseSeconds?: number;
}

export interface RelayResult {
  published: number;
  failed: number;
}

/** Exponential backoff for failed publishes: 10 s, 20 s, 40 s … capped at 1 h. */
export function outboxRetryDelaySeconds(attemptCount: number): number {
  return Math.min(10 * 2 ** Math.max(0, attemptCount), 3_600);
}

/**
 * One relay pass: claim due `job_outbox` rows (SKIP LOCKED + lease), publish them to the JOBS
 * queue with the row's dedupe key, then mark them processed. Safe to run concurrently and
 * repeatedly; a failed publish bumps `attempt_count`/`last_error` and reschedules the row.
 */
export async function relayOutbox(
  repo: OutboxRepository,
  queue: QueueProducer,
  log: Logger,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = Math.min(options.batchSize ?? 100, 100);
  const maxBatches = options.maxBatches ?? 10;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const result: RelayResult = { published: 0, failed: 0 };

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await repo.claim(batchSize, leaseSeconds);
    if (rows.length === 0) break;

    const valid: { id: string; message: QueueMessage }[] = [];
    for (const row of rows) {
      try {
        valid.push({ id: row.id, message: outboxRowToQueueMessage(row) });
      } catch {
        // A malformed row is a producer bug; keep it visible (last_error) with long backoff.
        await repo.markFailed(row.id, 'invalid outbox payload', 3_600);
        log.error('invalid outbox row', { outboxId: row.id, eventName: row.eventName });
        result.failed++;
      }
    }
    if (valid.length > 0) {
      try {
        await queue.sendBatch(
          valid.map((v) => ({ body: v.message, contentType: 'json' as const })),
        );
        await repo.markPublished(valid.map((v) => v.id));
        result.published += valid.length;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const row of rows.filter((r) => valid.some((v) => v.id === r.id))) {
          await repo.markFailed(
            row.id,
            `publish failed: ${reason}`,
            outboxRetryDelaySeconds(row.attemptCount),
          );
        }
        log.error('outbox publish failed', { count: valid.length, error: reason.slice(0, 200) });
        result.failed += valid.length;
        break;
      }
    }
    if (rows.length < batchSize) break;
  }
  return result;
}
