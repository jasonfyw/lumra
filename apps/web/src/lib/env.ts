import 'server-only';
import { parseEnv, webServerEnvSchema, type WebServerEnv } from '@lumra/config';

let cached: WebServerEnv | undefined;

/** Parsed server env. Called from `instrumentation.ts` so a bad env fails at boot, not mid-request. */
export function serverEnv(): WebServerEnv {
  cached ??= parseEnv('web', webServerEnvSchema, process.env);
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
