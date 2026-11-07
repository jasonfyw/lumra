import 'server-only';
import { parseEnv, webServerEnvSchema, type WebServerEnv } from '@lumra/config';

let cached: WebServerEnv | undefined;

/**
 * Vercel's Supabase integration provisions its own variable names. Map them onto ours so a
 * linked project works without duplicating secrets; explicit Lumra names always win.
 */
export function withIntegrationAliases(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL;
  return {
    ...env,
    DATABASE_URL: env.DATABASE_URL || env.POSTGRES_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_APP_URL:
      env.NEXT_PUBLIC_APP_URL || (productionHost ? `https://${productionHost}` : undefined),
  };
}

/** Parsed server env. Called from `instrumentation.ts` so a bad env fails at boot, not mid-request. */
export function serverEnv(): WebServerEnv {
  cached ??= parseEnv('web', webServerEnvSchema, withIntegrationAliases(process.env));
  return cached;
}

/** Test hook: forget the parsed env so the next `serverEnv()` re-reads `process.env`. */
export function resetServerEnvForTests(): void {
  cached = undefined;
}

/**
 * A server env var that this code path cannot run without. Thrown at use (not at boot) so builds,
 * CI and pages that don't need the var keep working; `withRoute` maps it to the generic 500 and
 * logs the variable *name* (never a value) so operators can see what is missing.
 */
export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Missing required server configuration: ${variable}`);
    this.name = 'ConfigurationError';
  }
}

type RequiredKey = {
  [K in keyof WebServerEnv]-?: undefined extends WebServerEnv[K] ? K : never;
}[keyof WebServerEnv];

export function requireEnv<K extends RequiredKey>(name: K): NonNullable<WebServerEnv[K]> {
  const value = serverEnv()[name];
  if (value === undefined || value === null || value === '') throw new ConfigurationError(name);
  return value as NonNullable<WebServerEnv[K]>;
}
