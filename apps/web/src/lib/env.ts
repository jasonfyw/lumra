import 'server-only';
import { parseEnv, webServerEnvSchema, type WebServerEnv } from '@lumra/config';

let cached: WebServerEnv | undefined;

/** Parsed server env. Called from `instrumentation.ts` so a bad env fails at boot, not mid-request. */
export function serverEnv(): WebServerEnv {
  cached ??= parseEnv('web', webServerEnvSchema, process.env);
  return cached;
}
