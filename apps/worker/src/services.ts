import {
  createAccessStateRepository,
  createMediaPipelineRepository,
  createOutboxRepository,
  createSqlClient,
  type AccessStateRepository,
  type MediaPipelineRepository,
  type OutboxRepository,
} from '@lumra/db';
import type postgres from 'postgres';
import type { Env } from './env';
import { createProcessorClient, type Fetcher, type ProcessorClient } from './processor-client';

/** Processor container instances jobs are spread over (each runs one job at a time). */
export const PROCESSOR_POOL_SIZE = 4;

export interface Services {
  mediaRepo(): MediaPipelineRepository;
  outboxRepo(): OutboxRepository;
  accessStateRepo(): AccessStateRepository;
  processor(): ProcessorClient;
  /** Closes the DB pool; call once the invocation's work is done. */
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

export function processorFetcher(env: Env): Fetcher {
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
    const mediaId = request.headers.get('x-lumra-media-id') ?? '';
    // Same addressing as `getContainer(namespace, name)` from @cloudflare/containers.
    const stub = namespace.get(namespace.idFromName(`image-processor-${poolIndex(mediaId)}`));
    return stub.fetch(request);
  };
}

/** Lazily created per invocation: no DB connection is opened unless a job needs one. */
export function createServices(env: Env): Services {
  let sql: postgres.Sql | undefined;
  const db = () => (sql ??= createSqlClient(databaseUrl(env), { max: 5 }));
  let processor: ProcessorClient | undefined;
  return {
    mediaRepo: () => createMediaPipelineRepository(db()),
    outboxRepo: () => createOutboxRepository(db()),
    accessStateRepo: () => createAccessStateRepository(db()),
    processor: () => (processor ??= createProcessorClient(processorFetcher(env))),
    async close() {
      if (sql) await sql.end({ timeout: 5 });
    },
  };
}
