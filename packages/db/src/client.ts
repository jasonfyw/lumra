/**
 * SERVER-ONLY. Builds a Drizzle client over a direct Postgres connection. The connection string
 * carries privileged credentials (it bypasses RLS), so this must only be constructed in trusted
 * server code (Next.js route handlers / server actions) or Workers — never in browser bundles.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Connection deadlines. Nothing may wait on Postgres forever: a hung connect or query used to
 * pin the job Worker until Cloudflare killed it at the 900 s wall-time limit. postgres.js 3.4
 * has no pool-queue timeout, so a wait for a free pool slot is bounded by the callers' own
 * deadlines (`apps/worker/src/deadline.ts`) on top of these driver/server limits.
 */
export const DB_TIMEOUTS = {
  /** TCP + TLS + auth handshake, seconds. */
  connectSeconds: 5,
  /** Close idle connections quickly (seconds); Workers isolates must not keep sockets around. */
  idleSeconds: 2,
  /** Server-side `statement_timeout` sent as a startup parameter, ms (0 = not sent). */
  statementMs: 15_000,
} as const;

export interface CreateDbOptions {
  /** Max pool size. Keep small on serverless (default 5). */
  max?: number;
  /**
   * Prepared statements. Must be false behind Supabase's transaction pooler (port 6543);
   * defaults to false so the same code works against the pooler and a direct connection.
   * Set true behind Hyperdrive: Cloudflare documents that postgres.js with `prepare: false`
   * can hang or fail intermittently there (extra Describe round trips per query).
   */
  prepare?: boolean;
  /** Idle timeout in seconds (default `DB_TIMEOUTS.idleSeconds`). */
  idleTimeoutSeconds?: number;
  /** Connect timeout in seconds (default `DB_TIMEOUTS.connectSeconds`). */
  connectTimeoutSeconds?: number;
  /**
   * Per-connection `statement_timeout` in ms, sent in the startup packet (default
   * `DB_TIMEOUTS.statementMs`). Pass 0 to send nothing — e.g. behind Hyperdrive, whose pooled
   * origin connections are shared and which does not document per-session settings.
   */
  statementTimeoutMs?: number;
}

export type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/**
 * Raw postgres.js client with the same defaults as `createDb`. Used by the repositories in
 * `./repositories` (Workers pass the Hyperdrive connection string here).
 *
 * `fetch_types: false` skips the array-type catalogue query on every new connection (one less
 * round trip that can stall, as Cloudflare recommends for Hyperdrive); JS arrays are therefore
 * not auto-serialized by postgres.js — pass them through `pgArray()` instead.
 */
export function createSqlClient(databaseUrl: string, options: CreateDbOptions = {}): postgres.Sql {
  if (!databaseUrl) throw new Error('createSqlClient: databaseUrl is required');
  return postgres(databaseUrl, sqlClientOptions(options));
}

/** The postgres.js options `createSqlClient` uses (exported for tests). */
export function sqlClientOptions(options: CreateDbOptions = {}) {
  const statementTimeoutMs = options.statementTimeoutMs ?? DB_TIMEOUTS.statementMs;
  return {
    max: options.max ?? 5,
    prepare: options.prepare ?? false,
    connect_timeout: options.connectTimeoutSeconds ?? DB_TIMEOUTS.connectSeconds,
    idle_timeout: options.idleTimeoutSeconds ?? DB_TIMEOUTS.idleSeconds,
    fetch_types: false,
    ...(statementTimeoutMs > 0 ? { connection: { statement_timeout: statementTimeoutMs } } : {}),
    // Never log query parameters (may contain capability hashes / emails).
    debug: false,
    onnotice: () => {},
  } satisfies postgres.Options<Record<string, postgres.PostgresType>>;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Database {
  if (!databaseUrl) throw new Error('createDb: databaseUrl is required');
  return drizzle(createSqlClient(databaseUrl, options), { schema });
}

/**
 * Postgres array literal (`{"a","b"}`) for a text-like array parameter, cast in SQL
 * (`= any(${pgArray(ids)}::uuid[])`). Needed because `fetch_types: false` leaves postgres.js
 * without array serializers.
 */
export function pgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}
