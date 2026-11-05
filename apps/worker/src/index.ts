import * as Sentry from '@sentry/cloudflare';
import { parseEnv, workerEnvSchema } from '@lumra/config';
import { queueMessageSchema, type QueueMessage } from '@lumra/contracts';
import {
  healthPayload,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sentryBaseOptions,
} from '@lumra/observability';
import type { Env } from './env';
import { syncGalleryAccessState } from './handlers/access-state';
import { handleMediaUploaded } from './handlers/media-uploaded';
import { loggerFor, type Logger } from './log';
import { relayOutbox } from './outbox-relay';
import { createServices, type Services } from './services';

export type { Env } from './env';

export interface JobContext {
  env: Env;
  services: Services;
  /** Bound to the message's `traceId`, type and message id. */
  log: Logger;
}

export type JobHandler = (message: QueueMessage, ctx: JobContext) => Promise<unknown>;

/**
 * Handlers are registered per message type as their tasks land (T12, T13, T24, T06).
 * A type without a handler (e.g. `media.delete` until T13) is retried after 60 s each time and
 * reaches the DLQ after `max_retries`; it never hot-loops and can be replayed once T13 ships.
 */
export const handlers: Partial<Record<QueueMessage['type'], JobHandler>> = {
  'media.uploaded': async (message, { env, services, log }) => {
    if (message.type !== 'media.uploaded') return;
    const outcome = await handleMediaUploaded(message, {
      repo: services.mediaRepo(),
      originals: env.ORIGINALS,
      derivatives: env.DERIVATIVES,
      processor: services.processor(),
      log,
    });
    log.info('media.uploaded handled', { mediaId: message.mediaId, outcome });
  },
  'gallery.access_changed': accessStateJob,
  // Tombstones the gateway's access state immediately (FR-G06). TODO(T13): also enqueue/perform
  // the R2 cleanup here; until then the nightly orphan sweep removes the objects.
  'gallery.delete': accessStateJob,
};

/** `gallery.access_changed` / `gallery.delete`: rewrite the gateway's KV access state (T20). */
async function accessStateJob(message: QueueMessage, { env, services, log }: JobContext) {
  if (message.type !== 'gallery.access_changed' && message.type !== 'gallery.delete') return;
  const outcome = await syncGalleryAccessState(message.galleryId, {
    repo: services.accessStateRepo(),
    kv: env.ACCESS_STATE,
    log,
  });
  log.info('access state synced', { galleryId: message.galleryId, outcome });
}

/** Cron that drives the outbox relay (wrangler.jsonc `triggers.crons`). */
export const OUTBOX_RELAY_CRON = '* * * * *';
/** Within one cron tick the relay keeps polling for this long, so pickup latency is ~seconds. */
export const OUTBOX_RELAY_WINDOW_MS = 50_000;
export const OUTBOX_RELAY_IDLE_MS = 3_000;
/** Delay before re-delivering a message whose type has no handler yet. */
export const UNHANDLED_RETRY_SECONDS = 60;

/** Queue retry delay: 20 s, 40 s, 80 s … capped at 15 min; then the DLQ (max_retries). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts * 10, 900);
}

export interface WorkerOptions {
  createServices?: (env: Env) => Services;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function closeServices(services: Services, ctx?: ExecutionContext) {
  const closing = services.close();
  if (ctx) ctx.waitUntil(closing);
  else await closing;
}

/** Raw handlers (testable with fake services); the default export wraps them with Sentry. */
export function createWorker(options: WorkerOptions = {}) {
  const makeServices = options.createServices ?? createServices;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  return {
    /** Only a sanitized liveness probe; the worker exposes no other HTTP surface. */
    async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
      const requestId = resolveRequestId(request);
      const headers = { 'Cache-Control': 'no-store', [REQUEST_ID_HEADER]: requestId };
      const { pathname } = new URL(request.url);
      if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
        return Response.json(healthPayload('worker', env.COMMIT_SHA), { headers });
      }
      return new Response('Not Found', { status: 404, headers });
    },

    async queue(batch: MessageBatch<unknown>, env: Env, ctx?: ExecutionContext): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      const log = loggerFor(env);
      const services = makeServices(env);
      try {
        for (const message of batch.messages) {
          const parsed = queueMessageSchema.safeParse(message.body);
          if (!parsed.success) {
            // Poison message: ack so it never blocks the queue; it is logged for manual replay.
            log.error('invalid queue message', { messageId: message.id, queue: batch.queue });
            message.ack();
            continue;
          }

          const { type, traceId } = parsed.data;
          const jobLog = log.child({ traceId, type, messageId: message.id });
          const handler = handlers[type];
          if (!handler) {
            jobLog.warn('no handler registered', { attempt: message.attempts });
            message.retry({ delaySeconds: UNHANDLED_RETRY_SECONDS });
            continue;
          }

          try {
            await handler(parsed.data, { env, services, log: jobLog });
            message.ack();
          } catch (error) {
            jobLog.error('job failed', { attempt: message.attempts, err: error });
            Sentry.withScope((scope) => {
              // Same tag as web so one search finds the request and the jobs it enqueued.
              scope.setTag('requestId', traceId);
              scope.setTag('jobType', type);
              Sentry.captureException(error);
            });
            message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          }
        }
      } finally {
        await closeServices(services, ctx);
      }
    },

    async scheduled(
      controller: ScheduledController,
      env: Env,
      ctx?: ExecutionContext,
    ): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      const log = loggerFor(env);
      if (controller.cron !== OUTBOX_RELAY_CRON) {
        // Reconcilers / cleanup land with T13.
        log.info('scheduled tick', { cron: controller.cron });
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
      } catch (error) {
        log.error('outbox relay failed', { err: error });
        Sentry.captureException(error);
        throw error;
      } finally {
        await closeServices(services, ctx);
      }
      if (totals.published > 0 || totals.failed > 0) log.info('outbox relay', totals);
    },
  } satisfies ExportedHandler<Env, unknown>;
}

export const worker = createWorker();

/** No `SENTRY_DSN` (dev/CI): returning undefined leaves the SDK uninitialised. */
export function sentryOptions(env: Env) {
  const options = sentryBaseOptions({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.COMMIT_SHA,
  });
  return options.enabled ? options : undefined;
}

export default Sentry.withSentry<Env, unknown, unknown, typeof worker>(sentryOptions, worker);
