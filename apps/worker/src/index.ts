import * as Sentry from '@sentry/cloudflare';
import { parseEnv, PROCESSOR_LIMITS, workerEnvSchema } from '@lumra/config';
import {
  deliveryServedMessageSchema,
  queueMessageSchema,
  type DeliveryServedMessage,
  type QueueMessage,
} from '@lumra/contracts';
import {
  healthPayload,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sentryBaseOptions,
} from '@lumra/observability';
import { DEADLINES, isDeadlineExceeded, withDeadline } from './deadline';
import type { Env } from './env';
import { syncGalleryAccessState } from './handlers/access-state';
import { handleMediaUploaded } from './handlers/media-uploaded';
import { ingestDeliveryEvents, runStorageAccrual } from './handlers/metering';
import { bounded, type StepTimings } from './instrument';
import { loggerFor, type Logger } from './log';
import { relayOutbox, type QueueProducer, type RelayResult } from './outbox-relay';
import { createServices, PROCESSOR_POOL_SIZE, type Services } from './services';

export type { Env } from './env';

export interface JobContext {
  env: Env;
  services: Services;
  /** Bound to the message's `traceId`, type and message id. */
  log: Logger;
  /** Fires when the job's overall deadline (`DEADLINES.jobMs`) passes. */
  signal: AbortSignal;
  /** Processor container slot reserved for this job within its batch (distinct per job). */
  slot: number;
  /** Per-step wall time, logged when the job ends. */
  timings: StepTimings;
}

export type JobHandler = (message: QueueMessage, ctx: JobContext) => Promise<unknown>;

/**
 * Handlers are registered per message type as their tasks land (T12, T13, T24, T06).
 * A type without a handler (e.g. `media.delete` until T13) is retried after 60 s each time and
 * reaches the DLQ after `max_retries`; it never hot-loops and can be replayed once T13 ships.
 *
 * Every dependency a handler touches is wrapped by `bounded()`: each DB / R2 / processor call
 * has its own deadline and the whole job is cut off at `DEADLINES.jobMs`.
 */
export const handlers: Partial<Record<QueueMessage['type'], JobHandler>> = {
  'media.uploaded': async (message, { env, services, log, signal, slot, timings }) => {
    if (message.type !== 'media.uploaded') return;
    const opts = { signal, timings };
    const outcome = await handleMediaUploaded(message, {
      repo: bounded(services.mediaRepo(), 'db', DEADLINES.dbStepMs, opts),
      originals: bounded(env.ORIGINALS, 'r2.originals', DEADLINES.r2StepMs, opts),
      derivatives: bounded(env.DERIVATIVES, 'r2.derivatives', DEADLINES.r2StepMs, opts),
      // The client aborts itself at clientTimeoutMs; this is only a backstop.
      processor: bounded(
        services.processor(slot),
        'processor',
        PROCESSOR_LIMITS.clientTimeoutMs + 5_000,
        opts,
      ),
      log,
    });
    log.info('media.uploaded handled', { mediaId: message.mediaId, outcome, slot });
  },
  'gallery.access_changed': accessStateJob,
  // Tombstones the gateway's access state immediately (FR-G06). TODO(T13): also enqueue/perform
  // the R2 cleanup here; until then the nightly orphan sweep removes the objects.
  'gallery.delete': accessStateJob,
};

/** `gallery.access_changed` / `gallery.delete`: rewrite the gateway's KV access state (T20). */
async function accessStateJob(message: QueueMessage, ctx: JobContext) {
  if (message.type !== 'gallery.access_changed' && message.type !== 'gallery.delete') return;
  const { env, services, log, signal, timings } = ctx;
  const outcome = await syncGalleryAccessState(message.galleryId, {
    repo: bounded(services.accessStateRepo(), 'db', DEADLINES.dbStepMs, { signal, timings }),
    kv: bounded(env.ACCESS_STATE, 'kv', DEADLINES.r2StepMs, { signal, timings }),
    log,
  });
  log.info('access state synced', { galleryId: message.galleryId, outcome });
}

/** Cron that drives the outbox relay (wrangler.jsonc `triggers.crons`). */
export const OUTBOX_RELAY_CRON = '* * * * *';
/** Within one cron tick the relay keeps polling for this long, so pickup latency is ~seconds. */
export const OUTBOX_RELAY_WINDOW_MS = DEADLINES.relayTickMs;
export const OUTBOX_RELAY_IDLE_MS = 3_000;
/** Delay before re-delivering a message whose type has no handler yet. */
export const UNHANDLED_RETRY_SECONDS = 60;
/** Hourly storage GB-month accrual (T27), off the hour and away from the other crons. */
export const STORAGE_ACCRUAL_CRON = '7 * * * *';
/** Wall-time budget for one accrual run; unfinished accounts are picked up next hour. */
export const STORAGE_ACCRUAL_BUDGET_MS = 50_000;

/**
 * Usage queues carry `delivery.served` events from the media gateway (`lumra-usage-dev`,
 * `lumra-usage-staging`, `lumra-usage`); they are ingested in whole batches into the ledger.
 */
export function isUsageQueue(queueName: string): boolean {
  return /^lumra-usage(-(dev|staging))?$/.test(queueName);
}

/** Path of the finalize "kick" (web → worker after an upload commits). */
export const RELAY_KICK_PATH = '/internal/relay';

/** Queue retry delay: 20 s, 40 s, 80 s … capped at 15 min; then the DLQ (max_retries). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts * 10, 900);
}

/**
 * Retry delay after a deadline fired (a hung DB connection / container, usually gone on the
 * next try): 5 s, 15 s, 60 s, 180 s, then 600 s.
 */
const TIMEOUT_RETRY_SECONDS = [5, 15, 60, 180, 600] as const;
export function timeoutRetryDelaySeconds(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), TIMEOUT_RETRY_SECONDS.length) - 1;
  return TIMEOUT_RETRY_SECONDS[index]!;
}

export interface WorkerOptions {
  createServices?: (env: Env) => Services;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Random source for the batch's first processor slot (tests pin it). */
  random?: () => number;
}

async function closeServices(services: Services, log: Logger, ctx?: ExecutionContext) {
  // `sql.end({ timeout })` is already time-boxed; the outer deadline guards a wedged socket.
  const closing = withDeadline(
    'db.close',
    (DEADLINES.closeSeconds + 1) * 1000,
    services.close(),
  ).catch((error: unknown) => log.warn('closing services failed', { err: error }));
  if (ctx) ctx.waitUntil(closing);
  else await closing;
}

/** SHA-256 both sides, then compare every byte: constant time whatever the input lengths. */
async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** Raw handlers (testable with fake services); the default export wraps them with Sentry. */
export function createWorker(options: WorkerOptions = {}) {
  const makeServices = options.createServices ?? createServices;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  /** Kick-triggered relay passes in flight in this isolate (at most one). */
  let kickInFlight: Promise<void> | null = null;

  /** One relay pass bounded by `ms`, with its outcome logged. Throws on failure/timeout. */
  async function relayPass(
    services: Services,
    queue: QueueProducer,
    log: Logger,
    ms: number,
    source: 'cron' | 'kick',
  ): Promise<RelayResult> {
    const started = now();
    try {
      const result = await withDeadline(`relay pass (${source})`, ms, (signal) =>
        relayOutbox(
          bounded(services.outboxRepo(), 'db.outbox', DEADLINES.dbStepMs, { signal }),
          bounded(queue, 'queue', DEADLINES.dbStepMs, { signal }),
          log,
        ),
      );
      if (result.claimed > 0 || result.failed > 0) {
        log.info('relay pass', { source, ...result, ms: now() - started });
      }
      return result;
    } catch (error) {
      if (isDeadlineExceeded(error)) {
        log.warn('deadline exceeded', { step: error.step, limitMs: error.ms, source });
      }
      throw error;
    }
  }

  async function runJob(
    message: Message<unknown>,
    queueName: string,
    env: Env,
    services: Services,
    log: Logger,
    slot: number,
  ): Promise<void> {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      // Poison message: ack so it never blocks the queue; it is logged for manual replay.
      log.error('invalid queue message', { messageId: message.id, queue: queueName });
      message.ack();
      return;
    }

    const { type, traceId } = parsed.data;
    const jobLog = log.child({ traceId, type, messageId: message.id });
    const handler = handlers[type];
    if (!handler) {
      jobLog.warn('no handler registered', { attempt: message.attempts });
      message.retry({ delaySeconds: UNHANDLED_RETRY_SECONDS });
      return;
    }

    const started = now();
    const timings: StepTimings = {};
    jobLog.info('job started', { attempt: message.attempts, slot });
    try {
      await withDeadline(`job ${type}`, DEADLINES.jobMs, (signal) =>
        handler(parsed.data, { env, services, log: jobLog, signal, slot, timings }),
      );
      message.ack();
      jobLog.info('job finished', { ms: now() - started, steps: timings });
    } catch (error) {
      const timedOut = isDeadlineExceeded(error);
      const delaySeconds = timedOut
        ? timeoutRetryDelaySeconds(message.attempts)
        : retryDelaySeconds(message.attempts);
      if (timedOut) {
        jobLog.warn('deadline exceeded', {
          step: error.step,
          limitMs: error.ms,
          attempt: message.attempts,
          ms: now() - started,
          steps: timings,
          retryInSeconds: delaySeconds,
        });
      } else {
        jobLog.error('job failed', {
          attempt: message.attempts,
          err: error,
          ms: now() - started,
          steps: timings,
        });
      }
      Sentry.withScope((scope) => {
        // Same tag as web so one search finds the request and the jobs it enqueued.
        scope.setTag('requestId', traceId);
        scope.setTag('jobType', type);
        Sentry.captureException(error);
      });
      message.retry({ delaySeconds });
    }
  }

  /**
   * One `lumra-usage-*` batch → one ledger insert (T27). Malformed messages are acked and logged
   * (they can never succeed); any DB failure retries the whole batch, which is safe because
   * ingestion is idempotent per event `dedupeKey`.
   */
  async function runUsageBatch(
    batch: MessageBatch<unknown>,
    services: Services,
    log: Logger,
  ): Promise<void> {
    const valid: { message: Message<unknown>; event: DeliveryServedMessage }[] = [];
    for (const message of batch.messages) {
      const parsed = deliveryServedMessageSchema.safeParse(message.body);
      if (parsed.success) valid.push({ message, event: parsed.data });
      else {
        log.error('invalid usage message', { messageId: message.id, queue: batch.queue });
        message.ack();
      }
    }
    if (valid.length === 0) return;
    const started = now();
    const timings: StepTimings = {};
    try {
      const result = await withDeadline('usage batch', DEADLINES.jobMs, (signal) => {
        const repo = services.billingRepo();
        const opts = { signal, timings };
        return ingestDeliveryEvents(
          valid.map((v) => v.event),
          {
            repo: bounded(repo, 'db', DEADLINES.dbStepMs, opts),
            ledger: bounded(repo.ledger, 'db.ledger', DEADLINES.dbStepMs, opts),
            log,
          },
        );
      });
      for (const { message } of valid) message.ack();
      log.info('usage batch ingested', { ...result, ms: now() - started, steps: timings });
    } catch (error) {
      const attempts = Math.max(...valid.map((v) => v.message.attempts));
      const delaySeconds = isDeadlineExceeded(error)
        ? timeoutRetryDelaySeconds(attempts)
        : retryDelaySeconds(attempts);
      log.error('usage batch failed', {
        size: valid.length,
        attempt: attempts,
        err: error,
        retryInSeconds: delaySeconds,
        steps: timings,
      });
      Sentry.withScope((scope) => {
        scope.setTag('jobType', 'delivery.served');
        Sentry.captureException(error);
      });
      for (const { message } of valid) message.retry({ delaySeconds });
    }
  }

  /** Hourly storage accrual run (T27). Per-account failures are logged inside the run. */
  async function storageAccrualTick(services: Services, log: Logger): Promise<void> {
    const started = now();
    const timings: StepTimings = {};
    const result = await runStorageAccrual({
      repo: bounded(services.billingRepo(), 'db', DEADLINES.dbStepMs, { timings }),
      log,
      now,
      budgetMs: STORAGE_ACCRUAL_BUDGET_MS,
    });
    log.info('storage accrual finished', { ...result, ms: now() - started, steps: timings });
  }

  return {
    /**
     * `GET /health` (sanitized liveness) and `POST /internal/relay` (the finalize kick: one
     * bounded outbox relay pass, bearer-authenticated, fail-closed when no secret is set).
     */
    async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
      const requestId = resolveRequestId(request);
      const headers = { 'Cache-Control': 'no-store', [REQUEST_ID_HEADER]: requestId };
      const { pathname } = new URL(request.url);
      if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
        return Response.json(healthPayload('worker', env.COMMIT_SHA), { headers });
      }
      if (pathname === RELAY_KICK_PATH) {
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: { ...headers, Allow: 'POST' },
          });
        }
        const log = loggerFor(env).child({ requestId });
        const secret = env.WORKER_KICK_SECRET;
        if (!secret) {
          log.warn('relay kick rejected: WORKER_KICK_SECRET is not configured');
          return new Response('Service Unavailable', { status: 503, headers });
        }
        const token = bearerToken(request);
        if (!token || !(await timingSafeEqualStrings(token, secret))) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { ...headers, 'WWW-Authenticate': 'Bearer' },
          });
        }
        if (kickInFlight) {
          return Response.json({ status: 'already_running' }, { status: 202, headers });
        }
        const run = (async () => {
          const services = makeServices(env);
          try {
            await relayPass(services, env.JOBS, log, DEADLINES.relayPassMs, 'kick');
          } catch (error) {
            // The cron relay is the fallback; a failed kick only costs latency.
            if (!isDeadlineExceeded(error)) log.error('relay kick failed', { err: error });
            Sentry.captureException(error);
          } finally {
            await closeServices(services, log);
          }
        })().finally(() => {
          kickInFlight = null;
        });
        kickInFlight = run;
        ctx?.waitUntil(run);
        return Response.json({ status: 'accepted' }, { status: 202, headers });
      }
      return new Response('Not Found', { status: 404, headers });
    },

    /**
     * Messages of a batch run concurrently, each acked/retried on its own. `media.uploaded` jobs
     * get distinct processor slots so they never queue behind each other on one container.
     */
    async queue(batch: MessageBatch<unknown>, env: Env, ctx?: ExecutionContext): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      const log = loggerFor(env);
      const services = makeServices(env);
      const started = now();
      if (isUsageQueue(batch.queue)) {
        try {
          await runUsageBatch(batch, services, log);
        } finally {
          await closeServices(services, log, ctx);
        }
        return;
      }
      const offset = Math.floor(random() * PROCESSOR_POOL_SIZE) % PROCESSOR_POOL_SIZE;
      let nextSlot = 0;
      const slots = batch.messages.map((message) => {
        const body = message.body as { type?: unknown } | null;
        const usesProcessor = body?.type === 'media.uploaded';
        return usesProcessor ? (offset + nextSlot++) % PROCESSOR_POOL_SIZE : offset;
      });
      log.info('queue batch started', { queue: batch.queue, size: batch.messages.length });
      try {
        const results = await Promise.allSettled(
          batch.messages.map((message, i) =>
            runJob(message, batch.queue, env, services, log, slots[i]!),
          ),
        );
        for (const [i, result] of results.entries()) {
          // runJob handles its own errors; this only catches a bug in that handling.
          if (result.status === 'rejected') {
            log.error('job crashed', { messageId: batch.messages[i]!.id, err: result.reason });
            batch.messages[i]!.retry({ delaySeconds: retryDelaySeconds(1) });
          }
        }
      } finally {
        await closeServices(services, log, ctx);
      }
      log.info('queue batch finished', {
        queue: batch.queue,
        size: batch.messages.length,
        ms: now() - started,
      });
    },

    async scheduled(
      controller: ScheduledController,
      env: Env,
      ctx?: ExecutionContext,
    ): Promise<void> {
      parseEnv('worker', workerEnvSchema, env as unknown as Record<string, unknown>);
      const log = loggerFor(env);
      if (controller.cron === STORAGE_ACCRUAL_CRON) {
        const services = makeServices(env);
        try {
          await storageAccrualTick(services, log);
        } catch (error) {
          log.error('storage accrual failed', { err: error });
          Sentry.captureException(error);
          throw error;
        } finally {
          await closeServices(services, log, ctx);
        }
        return;
      }
      if (controller.cron !== OUTBOX_RELAY_CRON) {
        // Reconcilers / cleanup land with T13.
        log.info('scheduled tick', { cron: controller.cron });
        return;
      }
      const services = makeServices(env);
      const started = now();
      const deadline = started + OUTBOX_RELAY_WINDOW_MS;
      const totals = { passes: 0, claimed: 0, published: 0, failed: 0 };
      log.info('cron tick started', { cron: controller.cron });
      try {
        while (true) {
          // Never start a pass that could run past the tick's window.
          const remaining = deadline - now();
          if (remaining < 1_000) break;
          const pass = await relayPass(
            services,
            env.JOBS,
            log,
            Math.min(DEADLINES.relayPassMs, remaining),
            'cron',
          );
          totals.passes++;
          totals.claimed += pass.claimed;
          totals.published += pass.published;
          totals.failed += pass.failed;
          if (now() + OUTBOX_RELAY_IDLE_MS >= deadline) break;
          if (pass.failed > 0) break;
          if (pass.claimed === 0) await sleep(OUTBOX_RELAY_IDLE_MS);
        }
      } catch (error) {
        if (!isDeadlineExceeded(error)) log.error('outbox relay failed', { err: error });
        Sentry.captureException(error);
        throw error;
      } finally {
        await closeServices(services, log, ctx);
        log.info('cron tick finished', { cron: controller.cron, ...totals, ms: now() - started });
      }
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
