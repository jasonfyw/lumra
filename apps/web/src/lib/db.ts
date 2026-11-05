import 'server-only';
import { createDb, type Database } from '@lumra/db';
import { serverEnv } from './env';

let db: Database | undefined;

/**
 * Privileged Drizzle client (bypasses RLS). Route handlers must authorize the actor
 * (`getActor`) before every query; browser code never receives this connection.
 */
export function getDb(): Database {
  if (!db) {
    const url = serverEnv().DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not configured');
    db = createDb(url);
  }
  return db;
}
