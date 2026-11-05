import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Route-level integration tests against the local Supabase Postgres (`pnpm test:db`). Route
 * handlers run for real (withRoute, actor resolution, Drizzle, rate limiter, SQL functions);
 * only the request scope (`next/headers` cookies), Supabase Auth `getUser` and R2 (`fetch`) are
 * faked — see test-db/setup.ts. Override the database with DATABASE_URL.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test-db/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test-db/**/*.test.ts'],
    setupFiles: ['test-db/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
