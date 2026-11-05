import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Route-handler integration tests against the local Supabase Postgres (`supabase start` in
// infra/). Auth (`getUser`) and `next/headers` cookies are stubbed per test; everything below the
// handler — Drizzle, SQL, constraints, row locks — is real. Override the target with DATABASE_URL.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test-db/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test-db/**/*.test.ts'],
    setupFiles: ['test-db/mocks.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      GUEST_CAPABILITY_PEPPER: 'test-pepper-test-pepper-test-pepper-0001',
      LOG_LEVEL: 'error',
    },
  },
});
