import { z } from 'zod';

/**
 * Runtime environment schemas. Each runtime parses its env once at boot via `parseEnv`
 * and aborts with a readable message on failure (T01).
 *
 * Provider credentials are optional until the task that integrates them lands; tighten
 * each to required in that task's PR (noted inline).
 */

const url = z.url();
const secret = z.string().min(32, 'must be at least 32 characters');
const logLevel = z.enum(['debug', 'info', 'warn', 'error']);

export const webServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: url,
  NEXT_PUBLIC_MEDIA_URL: url.optional(), // required by T20
  NEXT_PUBLIC_SUPABASE_URL: url.optional(), // required by T05
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(), // required by T05
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), // required by T02/T06
  DATABASE_URL: url.optional(), // required by T02
  GUEST_CAPABILITY_PEPPER: secret.optional(), // required by T06
  MEDIA_TOKEN_SECRET: secret.optional(), // required by T20
  R2_ACCOUNT_ID: z.string().optional(), // required by T09
  R2_ACCESS_KEY_ID: z.string().optional(), // required by T09
  R2_SECRET_ACCESS_KEY: z.string().optional(), // required by T09
  R2_BUCKET_ORIGINALS: z.string().default('lumra-originals'),
  STRIPE_SECRET_KEY: z.string().optional(), // required by T29
  STRIPE_WEBHOOK_SECRET: z.string().optional(), // required by T29
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(), // required by T29
  SENTRY_DSN: url.optional(), // server/edge; absent ⇒ Sentry disabled (T04)
  NEXT_PUBLIC_SENTRY_DSN: url.optional(), // browser; inlined at build time
  SENTRY_ENVIRONMENT: z.string().optional(), // defaults to VERCEL_ENV / NODE_ENV
  VERCEL_GIT_COMMIT_SHA: z.string().optional(), // Sentry release + /api/health `commit`
  LOG_LEVEL: logLevel.default('info'),
});
export type WebServerEnv = z.infer<typeof webServerEnvSchema>;

/** Observability vars shared by both Workers (T04). All optional: absent ⇒ Sentry disabled. */
const workerObservability = {
  SENTRY_DSN: url.optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  LOG_LEVEL: logLevel.optional(),
  COMMIT_SHA: z.string().optional(), // set at deploy: `wrangler deploy --var COMMIT_SHA:<sha>`
};

export const mediaGatewayEnvSchema = z.object({
  APP_ORIGIN: url,
  MEDIA_TOKEN_SECRET: secret.optional(), // required by T20
  ...workerObservability,
});
export type MediaGatewayEnv = z.infer<typeof mediaGatewayEnvSchema>;

export const workerEnvSchema = z.object({
  DATABASE_URL: url.optional(), // required by T12
  ...workerObservability,
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(
    readonly runtime: string,
    readonly issues: string[],
  ) {
    super(`Invalid ${runtime} environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv<S extends z.ZodType>(
  runtime: string,
  schema: S,
  source: Record<string, unknown>,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      runtime,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
