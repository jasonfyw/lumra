/**
 * Database access layer (T02, ADR-007). SQL migrations in `infra/supabase/migrations` are the
 * source of truth; this package mirrors them as a Drizzle schema for typed queries.
 * `createDb` is server-only: it uses a privileged connection that bypasses RLS.
 */
export * from './client';
export * from './enums';
export * from './schema';
