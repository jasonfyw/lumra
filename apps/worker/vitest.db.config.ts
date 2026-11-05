import { defineConfig } from 'vitest/config';

// Worker integration tests against local Supabase (`pnpm test:db`): real repositories and SQL,
// fake R2 / processor / queue. Override the database with DATABASE_URL.
export default defineConfig({
  test: {
    include: ['test-db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
