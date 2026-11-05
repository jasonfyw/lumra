/**
 * SERVER-ONLY. Builds a Drizzle client over a direct Postgres connection. The connection string
 * carries privileged credentials (it bypasses RLS), so this must only be constructed in trusted
 * server code (Next.js route handlers / server actions) or Workers — never in browser bundles.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface CreateDbOptions {
  /** Max pool size. Keep small on serverless (default 5). */
  max?: number;
  /**
   * Prepared statements. Must be false behind Supabase's transaction pooler (port 6543);
   * defaults to false so the same code works against the pooler and a direct connection.
   */
  prepare?: boolean;
}

export type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Database {
  if (!databaseUrl) throw new Error('createDb: databaseUrl is required');
  const client = postgres(databaseUrl, {
    max: options.max ?? 5,
    prepare: options.prepare ?? false,
    // Never log query parameters (may contain capability hashes / emails).
    debug: false,
  });
  return drizzle(client, { schema });
}
