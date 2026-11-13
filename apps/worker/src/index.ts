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
import { archiveCrc32 } from './crc';
import { syncGalleryAccessState } from './handlers/access-state';
import { handleArchiveBuild, RetryLaterError } from './handlers/archive-build';
import { evaluateBillingSafeguards, handleEmailSend, runBillingSweep } from './handlers/billing';
import { sweepArchives } from './handlers/archive-sweep';
import { handleMediaUploaded } from './handlers/media-uploaded';
import { ingestDeliveryEvents, runStorageAccrual } from './handlers/metering';
import { purgeGallery, purgeMedia, sweepDeletions, type PurgeDeps } from './handlers/purge';
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
  /** 1-based delivery attempt of this message (`message.attempts`). */
  attempt: number;
}

export type JobHandler = (message: QueueMessage, ctx: JobContext) => Promise<unknown>;

/**
 * Handlers are registered per message type as their tasks land (T12, T13, T24, T06).
 * A valid message whose type has no handler is logged as an error and acked (see `runJob`):
 * retrying it could never succeed and only parked it in the consumer-less DLQ.
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
  /**
   * T24: stream the job's ZIP parts into temp-archives (ADR-003). Runs under
   * `DEADLINES.archiveJobMs`; R2 multipart objects are used unwrapped (their per-part calls are
   * bounded by the job deadline) because `bounded()` would make `resumeMultipartUpload` async.
   */
  'archive.build': async (message, { env, services, log, signal, timings, attempt }) => {
    if (message.type !== 'archive.build') return;
    const opts = { signal, timings };
    const outcome = await handleArchiveBuild(message.jobId, {
      repo: bounded(services.archiveRepo(), 'db', DEADLINES.dbStepMs, opts),
      originals: bounded(env.ORIGINALS, 'r2.originals', DEADLINES.r2StepMs, opts),
      archives: env.ARCHIVES,
      crc32: archiveCrc32,
      attempt,
      log,
    });
    log.info('archive.build handled', { jobId: message.jobId, outcome, attempt });
  },
  // FR-G06: KV tombstone first, then the R2 purge (T13).
  'gallery.delete': galleryDeleteJob,
  'media.delete': mediaDeleteJob,
  // T33/T32: transition notices and spend-cap alerts (no provider yet: logged and acked).
  'email.send': async (message, { log }) => {
    if (message.type !== 'email.send') return;
    const outcome = await handleEmailSend(message, { log });
    log.info('email.send handled', { template: message.template, outcome });
  },
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

/** Purge dependencies, each call bounded by its own deadline (T13). */
function purgeDeps(
  env: Env,
  services: Services,
  log: Logger,
  opts: { signal?: AbortSignal; timings?: StepTimings },
  now: () => number = Date.now,
): PurgeDeps {
  return {
    repo: bounded(services.deletionRepo(), 'db', DEADLINES.dbStepMs, opts),
    originals: bounded(env.ORIGINALS, 'r2.originals', DEADLINES.r2StepMs, opts),
    derivatives: bounded(env.DERIVATIVES, 'r2.derivatives', DEADLINES.r2StepMs, opts),
    archives: bounded(env.ARCHIVES, 'r2.archives', DEADLINES.r2StepMs, opts),
    log,
    now,
  };
}

/** Thrown when a purge ran out of time: the queue retries and the next run continues. */
export class PurgeIncompleteError extends Error {
  constructor(readonly galleryId: string) {
    super('gallery purge incomplete; will continue on retry');
    this.name = 'PurgeIncompleteError';
  }
}

/** Gallery purge budget inside one job, leaving headroom under `DEADLINES.jobMs`. */
export const GALLERY_PURGE_BUDGET_MS = 90_000;

/** `media.delete`: remove the original + derivatives from R2, then mark the row `deleted`. */
async function mediaDeleteJob(message: QueueMessage, ctx: JobContext) {
  if (message.type !== 'media.delete') return;
  const { env, services, log, signal, timings } = ctx;
  const result = await purgeMedia(
    [message.mediaId],
    purgeDeps(env, services, log, { signal, timings }),
  );
  log.info('media purge finished', { mediaId: message.mediaId, ...result });
}

/** `gallery.delete`: KV tombstone (gateway denies at once), then purge every object (FR-G06). */
async function galleryDeleteJob(message: QueueMessage, ctx: JobContext) {
  if (message.type !== 'gallery.delete') return;
  await accessStateJob(message, ctx);
  const { env, services, log, signal, timings } = ctx;
  const result = await purgeGallery(
    message.galleryId,
    purgeDeps(env, services, log, { signal, timings }),
    { budgetMs: GALLERY_PURGE_BUDGET_MS },
  );
  log.info('gallery purge finished', {
    galleryId: message.galleryId,
    outcome: result.outcome,
    archiveObjects: result.archiveObjects,
    archiveJobs: result.archiveJobs,
    derivativePrefixObjects: result.derivativePrefixObjects,
    ...result.media,
  });
  if (result.outcome === 'incomplete') throw new PurgeIncompleteError(message.galleryId);
}

/** Cron that drives the outbox relay (wrangler.jsonc `triggers.crons`). */
export const OUTBOX_RELAY_CRON = '* * * * *';
/** Within one cron tick the relay keeps polling for this long, so pickup latency is ~seconds. */
export const OUTBOX_RELAY_WINDOW_MS = DEADLINES.relayTickMs;
export const OUTBOX_RELAY_IDLE_MS = 3_000;
/** Whole-job deadline per message type (archive builds stream up to ~2 GB per part). */
export function jobDeadlineMs(type: QueueMessage['type']): number {
  return type === 'archive.build' ? DEADLINES.archiveJobMs : DEADLINES.jobMs;
}

/** Delay before re-delivering a message whose type has no handler yet. */
export const UNHANDLED_RETRY_SECONDS = 60;
/** Backstop deletion sweep (T13, FR-G06): stuck `deleting` media and deleted galleries. */
export const DELETION_SWEEP_CRON = '*/15 * * * *';
/** Wall-time budget for one sweep; the rest of the backlog is picked up 15 minutes later. */
export const DELETION_SWEEP_BUDGET_MS = 50_000;
/**
 * Hourly storage GB-month accrual (T27), off the hour and away from the other crons; the billing
 * sweep (T33: past-due grace, canceled → free, delivery cutoff) runs right after it.
 */
export const STORAGE_ACCRUAL_CRON = '7 * * * *';
/**
 * Archive TTL / stalled-job sweep (T25). Shares the 15-minute reconcile tick with the deletion
 * sweep (one cron string can only dispatch once), so it is an alias, not a separate trigger.
 */
export const ARCHIVE_SWEEP_CRON = DELETION_SWEEP_CRON;

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
      // Ack, don't retry: redelivery can't succeed and the DLQ has no consumer. The error log +
      // Sentry event are the record; the outbox row (same dedupeKey) can be re-queued once a
      // handler ships.
      jobLog.error('no handler registered; message dropped', {
        attempt: message.attempts,
        dedupeKey: parsed.data.dedupeKey,
      });
      Sentry.withScope((scope) => {
        scope.setTag('requestId', traceId);
        scope.setTag('jobType', type);
        Sentry.captureMessage(`no handler registered for ${type}`, 'error');
      });
      message.ack();
      return;
    }

    const started = now();
    const timings: StepTimings = {};
    jobLog.info('job started', { attempt: message.attempts, slot });
    try {
      await withDeadline(`job ${type}`, jobDeadlineMs(type), (signal) =>
        handler(parsed.data, {
          env,
          services,
          log: jobLog,
          signal,
          slot,
          timings,
          attempt: message.attempts,
        }),
      );
      message.ack();
      jobLog.info('job finished', { ms: now() - started, steps: timings });
    } catch (error) {
      if (error instanceof RetryLaterError) {
        // Expected back-off (e.g. another delivery holds an archive build lease): no Sentry.
        jobLog.info('job deferred', { reason: error.message, retryInSeconds: error.delaySeconds });
        message.retry({ delaySeconds: error.delaySeconds });
        return;
      }
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
      const result = await withDeadline('usage batch', DEADLINES.jobMs, async (signal) => {
        const repo = services.billingRepo();
        const opts = { signal, timings };
        const ingested = await ingestDeliveryEvents(
          valid.map((v) => v.event),
          {
            repo: bounded(repo, 'db', DEADLINES.dbStepMs, opts),
            ledger: bounded(repo.ledger, 'db.ledger', DEADLINES.dbStepMs, opts),
            log,
          },
        );
        // Delivery safety cutoff (T28 Free cap / T32 spend cap) for the accounts just metered.
        // A failure retries the batch: ingestion is idempotent, so only the evaluation re-runs.
        const safeguards = await evaluateBillingSafeguards(ingested.accountIds, {
          repo: bounded(services.billingStateRepo(), 'db.billing', DEADLINES.dbStepMs, opts),
          log,
          now: () => new Date(now()),
          traceId: `usage:${batch.queue}`,
        });
        return { ingested, safeguards };
      });
      for (const { message } of valid) message.ack();
      log.info('usage batch ingested', {
        received: result.ingested.received,
        inserted: result.ingested.inserted,
        duplicates: result.ingested.duplicates,
        skippedGuest: result.ingested.skippedGuest,
        skippedUnknownGallery: result.ingested.skippedUnknownGallery,
        skippedNoAccount: result.ingested.skippedNoAccount,
        safeguards: result.safeguards,
        ms: now() - started,
        steps: timings,
      });
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

  /** Hourly billing maintenance (T33) + delivery cutoff re-evaluation (T28/T32). */
  async function billingSweepTick(services: Services, log: Logger): Promise<void> {
    const started = now();
    const timings: StepTimings = {};
    const repo = bounded(services.billingStateRepo(), 'db.billing', DEADLINES.dbStepMs, {
      timings,
    });
    const result = await runBillingSweep({
      repo,
      plans: bounded(services.billingRepo().plans, 'db.plans', DEADLINES.dbStepMs, { timings }),
      log,
      now: () => new Date(now()),
      traceId: 'cron:billing-sweep',
    });
    log.info('billing sweep finished', { ...result, ms: now() - started, steps: timings });
  }

  /** Backstop deletion sweep (T13). Per-item failures are logged inside the sweep. */
  async function deletionSweepTick(env: Env, services: Services, log: Logger): Promise<void> {
    const started = now();
    const timings: StepTimings = {};
    const result = await sweepDeletions(purgeDeps(env, services, log, { timings }, now), {
      budgetMs: DELETION_SWEEP_BUDGET_MS,
      nowDate: new Date(now()),
    });
    log.info('deletion sweep finished', {
      galleries: result.galleries,
      galleriesIncomplete: result.galleriesIncomplete,
      galleriesFailed: result.galleriesFailed,
      mediaBatchesFailed: result.mediaBatchesFailed,
      budgetExhausted: result.budgetExhausted,
      ...result.media,
      ms: now() - started,
      steps: timings,
    });
  }

  async function archiveSweepTick(env: Env, services: Services, log: Logger): Promise<void> {
    const timings: StepTimings = {};
    const result = await sweepArchives({
      repo: bounded(services.archiveRepo(), 'db', DEADLINES.dbStepMs, { timings }),
      archives: bounded(env.ARCHIVES, 'r2.archives', DEADLINES.r2StepMs, { timings }),
      log,
      now,
    });
    log.info('archive sweep finished', { ...result, steps: timings });
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
        // Accrual first (it moves Pro spend), then the billing sweep reads the new totals. Each
        // failure is reported on its own so one never blocks the other.
        const services = makeServices(env);
        let firstError: unknown;
        try {
          try {
            await storageAccrualTick(services, log);
          } catch (error) {
            log.error('storage accrual failed', { err: error });
            Sentry.captureException(error);
            firstError ??= error;
          }
          try {
            await billingSweepTick(services, log);
          } catch (error) {
            log.error('billing sweep failed', { err: error });
            Sentry.captureException(error);
            firstError ??= error;
          }
        } finally {
          await closeServices(services, log, ctx);
        }
        if (firstError !== undefined) throw firstError;
        return;
      }
      if (controller.cron === DELETION_SWEEP_CRON) {
        // One 15-minute reconcile tick runs both sweeps; each failure is reported on its own so
        // a broken deletion sweep never stops archive expiry (and vice versa).
        const services = makeServices(env);
        let firstError: unknown;
        try {
          try {
            await deletionSweepTick(env, services, log);
          } catch (error) {
            log.error('deletion sweep failed', { err: error });
            Sentry.captureException(error);
            firstError ??= error;
          }
          try {
            await archiveSweepTick(env, services, log);
          } catch (error) {
            log.error('archive sweep failed', { err: error });
            Sentry.captureException(error);
            firstError ??= error;
          }
        } finally {
          await closeServices(services, log, ctx);
        }
        if (firstError !== undefined) throw firstError;
        return;
      }
      if (controller.cron !== OUTBOX_RELAY_CRON) {
        // Nightly R2 orphan reconcile and guest-draft expiry: remaining T13 work.
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
