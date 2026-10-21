import { parseEnv, workerEnvSchema } from '@lumra/config';
import { queueMessageSchema, type QueueMessage } from '@lumra/contracts';

export interface Env {
  DATABASE_URL?: string;
  SENTRY_DSN?: string;
  JOBS: Queue<QueueMessage>;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}

export type JobHandler = (message: QueueMessage, env: Env) => Promise<void>;

/** Handlers are registered per message type as their tasks land (T12, T13, T24, T06). */
export const handlers: Partial<Record<QueueMessage['type'], JobHandler>> = {};

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const sink = { info: console.info, warn: console.warn, error: console.error }[level];
  sink(JSON.stringify({ level, msg, ...fields }));
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);

    for (const message of batch.messages) {
      const parsed = queueMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        // Poison message: ack so it never blocks the queue; it is logged for manual replay.
        log('error', 'invalid queue message', { messageId: message.id });
        message.ack();
        continue;
      }

      const handler = handlers[parsed.data.type];
      if (!handler) {
        log('warn', 'no handler registered', {
          type: parsed.data.type,
          traceId: parsed.data.traceId,
        });
        message.retry({ delaySeconds: 60 });
        continue;
      }

      try {
        await handler(parsed.data, env);
        message.ack();
      } catch (error) {
        log('error', 'job failed', {
          type: parsed.data.type,
          traceId: parsed.data.traceId,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry({ delaySeconds: Math.min(2 ** message.attempts * 10, 900) });
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
    log('info', 'scheduled tick', { cron: controller.cron });
  },
} satisfies ExportedHandler<Env, unknown>;
