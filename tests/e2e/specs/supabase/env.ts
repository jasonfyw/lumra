/** Local Supabase stack used by the `auth-supabase` project (E2E_SUPABASE=1). */
export const SUPABASE_E2E = {
  apiUrl: process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  // The well-known public demo anon key of every local Supabase stack (not a secret).
  anonKey:
    process.env.E2E_SUPABASE_ANON_KEY ??
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  databaseUrl:
    process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  mailpitUrl: process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:54324',
  // Test-only pepper so specs can mint guest capabilities the server accepts.
  guestPepper: 'e2e-guest-pepper-e2e-guest-pepper-000001',
};
