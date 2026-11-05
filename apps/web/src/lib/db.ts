import 'server-only';
import { createDb, type Database } from '@lumra/db';
import { requireEnv } from './env';

let db: Database | undefined;

/**
 * Privileged Drizzle client (bypasses RLS). Route handlers must authorize the actor
 * (`getActor`) before every query; browser code never receives this connection.
 */
export function getDb(): Database {
  if (!db) {
    db = createDb(requireEnv('DATABASE_URL'));
  }
  return db;
}

/** A Drizzle transaction handle (`db.transaction(async (tx) => …)`). */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
