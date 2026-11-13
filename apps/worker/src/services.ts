import {
  createAccessStateRepository,
  createArchiveRepository,
  createBillingRepository,
  createBillingStateRepository,
  createDeletionRepository,
  createMeterExportRepository,
  createMediaPipelineRepository,
  createOutboxRepository,
  createSqlClient,
  type AccessStateRepository,
  type ArchiveRepository,
  type BillingRepository,
  type BillingStateRepository,
  type DeletionRepository,
  type MeterExportRepository,
  type MediaPipelineRepository,
  type OutboxRepository,
} from '@lumra/db';
import type postgres from 'postgres';
import { DEADLINES } from './deadline';
import type { Env } from './env';
import { createProcessorClient, type Fetcher, type ProcessorClient } from './processor-client';

/** Processor container instances jobs are spread over (each runs one job at a time). */
export const PROCESSOR_POOL_SIZE = 4;

export interface Services {
  mediaRepo(): MediaPipelineRepository;
  outboxRepo(): OutboxRepository;
  accessStateRepo(): AccessStateRepository;
  /** Archive jobs/parts for `archive.build` and the archive sweep (T24/T25). */
  archiveRepo(): ArchiveRepository;
  /** Rate card, usage ledger and metering reads/writes (T27). */
  billingRepo(): BillingRepository;
  /** Spend-cap alerts + hourly billing sweep (T32/T33). */
  billingStateRepo(): BillingStateRepository;
  /** Stripe meter export cursors and stored events (T31). */
  meterExportRepo(): MeterExportRepository;
  /** Physical deletion: purge reads/marks and the backstop sweep (T13). */
  deletionRepo(): DeletionRepository;
  /**
   * Processor client. `slot` pins the container instance (0..PROCESSOR_POOL_SIZE-1) so the
   * concurrent jobs of one batch never share an instance (`processor_busy`); without it the
   * instance is chosen by media id.
   */
  processor(slot?: number): ProcessorClient;
  /** Closes the DB pool (time-boxed); call once the invocation's work is done. */
  close(): Promise<void>;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function databaseUrl(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new ConfigurationError('Neither HYPERDRIVE nor DATABASE_URL is configured');
  return url;
}

/** Stable instance choice per media id so a redelivery tends to hit a warm container. */
function poolIndex(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % PROCESSOR_POOL_SIZE;
}

export function processorFetcher(env: Env, slot?: number): Fetcher {
  if (env.PROCESSOR_URL) {
    const base = env.PROCESSOR_URL.replace(/\/$/, '');
    return (request) => {
      const url = new URL(request.url);
      return fetch(new Request(`${base}${url.pathname}`, request));
    };
  }
  const namespace = env.IMAGE_PROCESSOR;
  if (!namespace) throw new ConfigurationError('Neither IMAGE_PROCESSOR nor PROCESSOR_URL is set');
  return (request) => {
    const index =
      slot === undefined
        ? poolIndex(request.headers.get('x-lumra-media-id') ?? '')
        : ((slot % PROCESSOR_POOL_SIZE) + PROCESSOR_POOL_SIZE) % PROCESSOR_POOL_SIZE;
    // Same addressing as `getContainer(namespace, name)` from @cloudflare/containers.
    const stub = namespace.get(namespace.idFromName(`image-processor-${index}`));
    return stub.fetch(request);
  };
}

/**
 * Lazily created per invocation: no DB connection is opened unless a job needs one.
 *
 * Behind Hyperdrive: prepared statements on (Cloudflare documents intermittent hangs with
 * postgres.js `prepare: false`) and no startup `statement_timeout` (Hyperdrive pools origin
 * connections across clients and doesn't document per-session settings) — the worker's own
 * deadlines bound every call instead. A direct `DATABASE_URL` (local/tests) keeps the defaults.
 */
export function createServices(env: Env): Services {
  let sql: postgres.Sql | undefined;
  const hyperdrive = Boolean(env.HYPERDRIVE?.connectionString);
  const db = () =>
    (sql ??= createSqlClient(databaseUrl(env), {
      max: 5,
      ...(hyperdrive ? { prepare: true, statementTimeoutMs: 0 } : {}),
    }));
  const processors = new Map<number | undefined, ProcessorClient>();
  return {
    mediaRepo: () => createMediaPipelineRepository(db()),
    outboxRepo: () => createOutboxRepository(db()),
    accessStateRepo: () => createAccessStateRepository(db()),
    archiveRepo: () => createArchiveRepository(db()),
    billingRepo: () => createBillingRepository(db()),
    billingStateRepo: () => createBillingStateRepository(db()),
    meterExportRepo: () => createMeterExportRepository(db()),
    deletionRepo: () => createDeletionRepository(db()),
    processor: (slot) => {
      let client = processors.get(slot);
      if (!client) {
        client = createProcessorClient(processorFetcher(env, slot));
        processors.set(slot, client);
      }
      return client;
    },
    async close() {
      if (sql) await sql.end({ timeout: DEADLINES.closeSeconds });
    },
  };
}
