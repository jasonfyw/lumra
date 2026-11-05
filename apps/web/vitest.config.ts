import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // test-db/ needs the local Supabase stack and runs via `pnpm test:db` (vitest.db.config.ts).
  test: { include: ['src/**/*.test.ts'] },
});
