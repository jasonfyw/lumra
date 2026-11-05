import { defineConfig } from 'vitest/config';

// Integration tests against the local Supabase Postgres (`supabase start` in infra/).
// Override the target with DATABASE_URL. Files run sequentially to keep fixtures independent.
export default defineConfig({
  test: {
    include: ['test-db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
