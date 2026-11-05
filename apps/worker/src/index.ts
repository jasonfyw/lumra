import { parseEnv, workerEnvSchema } from '@lumra/config';
import { queueMessageSchema, type QueueMessage } from '@lumra/contracts';
import type { Env } from './env';
import { handleMediaUploaded } from './handlers/media-uploaded';
import { log } from './log';
import { relayOutbox } from './outbox-relay';
import { createServices, type Services } from './services';

export type { Env } from './env';

export interface JobContext {
  env: Env;
  services: Services;
}

export type JobHandler = (message: QueueMessage, ctx: JobContext) => Promise<unknown>;

/** Handlers are registered per message type as their tasks land (T12, T13, T24, T06). */
export const handlers: Partial<Record<QueueMessage['type'], JobHandler>> = {
  'media.uploaded': async (message, { env, services }) => {
    if (message.type !== 'media.uploaded') return;
    const outcome = await handleMediaUploaded(message, {
      repo: services.mediaRepo(),
      originals: env.ORIGINALS,
      derivatives: env.DERIVATIVES,
      processor: services.processor(),
      log,
    });
    log('info', 'media.uploaded handled', {
      mediaId: message.mediaId,
      traceId: message.traceId,
      outcome,
    });
  },
};

/** Cron that drives the outbox relay (wrangler.jsonc `triggers.crons`). */
export const OUTBOX_RELAY_CRON = '* * * * *';
/** Within one cron tick the relay keeps polling for this long, so pickup latency is ~seconds. */
export const OUTBOX_RELAY_WINDOW_MS = 50_000;
export const OUTBOX_RELAY_IDLE_MS = 3_000;

/** Queue retry delay: 20 s, 40 s, 80 s … capped at 15 min; then the DLQ (max_retries). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts * 10, 900);
}

export interface WorkerOptions {
  createServices?: (env: Env) => Services;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createWorker(options: WorkerOptions = {}) {
  const makeServices = options.createServices ?? createServices;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  return {
    async queue(batch: MessageBatch<unknown>, env: Env, ctx?: ExecutionContext): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      const services = makeServices(env);
      try {
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
            await handler(parsed.data, { env, services });
            message.ack();
          } catch (error) {
            log('error', 'job failed', {
              type: parsed.data.type,
              traceId: parsed.data.traceId,
              messageId: message.id,
              attempt: message.attempts,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          }
        }
      } finally {
        const closing = services.close();
        if (ctx) ctx.waitUntil(closing);
        else await closing;
      }
    },

    async scheduled(
      controller: ScheduledController,
      env: Env,
      ctx?: ExecutionContext,
    ): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      if (controller.cron !== OUTBOX_RELAY_CRON) {
        // Reconcilers / cleanup land with T13.
        log('info', 'scheduled tick', { cron: controller.cron });
        return;
      }
      const services = makeServices(env);
      const deadline = now() + OUTBOX_RELAY_WINDOW_MS;
      const totals = { published: 0, failed: 0 };
      try {
        const repo = services.outboxRepo();
        while (true) {
          const pass = await relayOutbox(repo, env.JOBS, log);
          totals.published += pass.published;
          totals.failed += pass.failed;
          if (now() + OUTBOX_RELAY_IDLE_MS >= deadline) break;
          if (pass.published === 0 && pass.failed === 0) await sleep(OUTBOX_RELAY_IDLE_MS);
          else if (pass.failed > 0) break;
        }
      } finally {
        const closing = services.close();
        if (ctx) ctx.waitUntil(closing);
        else await closing;
      }
      if (totals.published > 0 || totals.failed > 0) log('info', 'outbox relay', totals);
    },
  } satisfies ExportedHandler<Env, unknown>;
}

export default createWorker();
