/**
 * Database access layer (T02, ADR-007). SQL migrations in `infra/supabase/migrations` are the
 * source of truth; this package mirrors them as a Drizzle schema for typed queries.
 * `createDb` is server-only: it uses a privileged connection that bypasses RLS.
 */
export * from './client';
export * from './enums';
export * from './schema';
export * from './repositories/media-pipeline';
export * from './repositories/outbox';
export * from './repositories/access-state';
export * from './repositories/billing';
export * from './repositories/archive';
export * from './repositories/deletion';
export * from './repositories/meter-export';
