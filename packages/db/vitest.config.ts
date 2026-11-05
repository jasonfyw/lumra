import { defineConfig } from 'vitest/config';

// Default unit tests: no database required. DB integration tests run via `pnpm test:db`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
