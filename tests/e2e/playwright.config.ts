import { defineConfig, devices } from '@playwright/test';
import { SUPABASE_E2E } from './specs/supabase/env';
import { FAKE_S3, FAKE_S3_ENDPOINT } from './specs/supabase/fake-s3';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
// Lets environments with a preinstalled Chromium skip `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

/**
 * `E2E_SUPABASE=1` adds the `auth-supabase` project (specs/supabase/**): real sign-in against the
 * local Supabase stack (`supabase start --workdir infra`), reading OTP emails from Mailpit.
 * The default run needs no Supabase and skips those specs. Use the default port 3000: it is the
 * stack's `site_url`, so magic-link redirects are allowlisted. Upload specs point `R2_ENDPOINT` at
 * the in-test fake S3 server (specs/supabase/fake-s3.ts); `E2E_DATABASE_URL` can select a private
 * database.
 */
const withSupabase = process.env.E2E_SUPABASE === '1';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: 'supabase/**',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testIgnore: 'supabase/**',
      use: { ...devices['Pixel 7'] },
    },
    ...(withSupabase
      ? [
          {
            name: 'auth-supabase',
            testMatch: 'supabase/**/*.spec.ts',
            use: devices['Desktop Chrome'],
          },
        ]
      : []),
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @lumra/web dev',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        env: {
          NEXT_PUBLIC_APP_URL: baseURL,
          ...(withSupabase
            ? {
                NEXT_PUBLIC_SUPABASE_URL: SUPABASE_E2E.apiUrl,
                NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_E2E.anonKey,
                DATABASE_URL: SUPABASE_E2E.databaseUrl,
                GUEST_CAPABILITY_PEPPER: SUPABASE_E2E.guestPepper,
                R2_ACCOUNT_ID: FAKE_S3.accountId,
                R2_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
                R2_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
                R2_BUCKET_ORIGINALS: FAKE_S3.bucket,
                R2_ENDPOINT: FAKE_S3_ENDPOINT,
              }
            : {}),
        },
      },
});
