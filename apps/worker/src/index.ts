import * as Sentry from '@sentry/cloudflare';
import { parseEnv, workerEnvSchema } from '@lumra/config';
import { queueMessageSchema, type QueueMessage } from '@lumra/contracts';
import {
  createLogger,
  healthPayload,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sentryBaseOptions,
  type Logger,
} from '@lumra/observability';

export interface Env {
  DATABASE_URL?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  /** Deployed git SHA, e.g. `wrangler deploy --var COMMIT_SHA:$GITHUB_SHA`. */
  COMMIT_SHA?: string;
  JOBS: Queue<QueueMessage>;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}

/** `log` is bound to the message's `traceId` and type. */
export type JobHandler = (message: QueueMessage, env: Env, log: Logger) => Promise<void>;

/** Handlers are registered per message type as their tasks land (T12, T13, T24, T06). */
export const handlers: Partial<Record<QueueMessage['type'], JobHandler>> = {};

function loggerFor(env: Env): Logger {
  return createLogger({
    service: 'worker',
    level: env.LOG_LEVEL,
    production: env.SENTRY_ENVIRONMENT === 'production',
  });
}

/** Raw handlers; the default export wraps them with Sentry. */
export const worker = {
  /** Only a sanitized liveness probe; the worker exposes no other HTTP surface. */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = resolveRequestId(request);
    const headers = { 'Cache-Control': 'no-store', [REQUEST_ID_HEADER]: requestId };
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return Response.json(healthPayload('worker', env.COMMIT_SHA), { headers });
    }
    return new Response('Not Found', { status: 404, headers });
  },

  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
    const log = loggerFor(env);

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
        jobLog.warn('no handler registered');
        message.retry({ delaySeconds: 60 });
        continue;
      }

      try {
        await handler(parsed.data, env, jobLog);
        message.ack();
      } catch (error) {
        jobLog.error('job failed', { attempt: message.attempts, err: error });
        Sentry.withScope((scope) => {
          // Same tag as web so one search finds the request and the jobs it enqueued.
          scope.setTag('requestId', traceId);
          scope.setTag('jobType', type);
          Sentry.captureException(error);
        });
        message.retry({ delaySeconds: Math.min(2 ** message.attempts * 10, 900) });
      }
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
    loggerFor(env).info('scheduled tick', { cron: controller.cron });
  },
} satisfies ExportedHandler<Env, unknown>;

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
