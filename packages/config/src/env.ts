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

/**
 * Media-token keyring (ADR-001). Format: `kid:secret[,kid:secret...]`.
 * The first entry is the active signing key (web); every entry is accepted for verification
 * (gateway), which allows zero-downtime rotation. A bare secret without `kid:` is accepted as
 * a single key with kid `default`. Secrets must be ≥32 characters and contain no `,` or `:`
 * (generate with `openssl rand -base64url 48` or similar). Error messages never echo values.
 */
export interface MediaTokenKeyring {
  activeKid: string;
  keys: ReadonlyMap<string, string>;
}

const MEDIA_TOKEN_KID = /^[A-Za-z0-9_-]{1,32}$/;

export const mediaTokenKeyringSchema = z.string().transform((raw, ctx): MediaTokenKeyring => {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const keys = new Map<string, string>();
  for (const entry of entries) {
    const sep = entry.indexOf(':');
    const kid = sep === -1 ? 'default' : entry.slice(0, sep);
    const value = sep === -1 ? entry : entry.slice(sep + 1);
    if (!MEDIA_TOKEN_KID.test(kid)) {
      ctx.addIssue({ code: 'custom', message: 'key id must match [A-Za-z0-9_-]{1,32}' });
      return z.NEVER;
    }
    if (value.length < 32 || value.includes(':')) {
      ctx.addIssue({ code: 'custom', message: 'each secret must be at least 32 characters' });
      return z.NEVER;
    }
    if (keys.has(kid)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate key id' });
      return z.NEVER;
    }
    keys.set(kid, value);
  }
  const activeKid = keys.keys().next().value;
  if (activeKid === undefined) {
    ctx.addIssue({ code: 'custom', message: 'must contain at least one key' });
    return z.NEVER;
  }
  return { activeKid, keys };
});

/** Comma-separated list of allowed browser origins, normalized to `scheme://host[:port]`. */
export const originListSchema = z.string().transform((raw, ctx): string[] => {
  const origins: string[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    if (!entry) continue;
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      origins.push(parsed.origin);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of origins' });
      return z.NEVER;
    }
  }
  if (origins.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'must contain at least one origin' });
    return z.NEVER;
  }
  return origins;
});

export const webServerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    NEXT_PUBLIC_APP_URL: url,
    NEXT_PUBLIC_MEDIA_URL: url.optional(), // required by T20
    // Required on Vercel deployments (see refinement below). Optional elsewhere so local builds,
    // CI and the e2e smoke run without a Supabase stack: auth then degrades to "signed out" (T05).
    NEXT_PUBLIC_SUPABASE_URL: url.optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), // required by T02/T06
    DATABASE_URL: url.optional(), // required at use by DB-backed routes (lib/env.ts requireEnv)
    GUEST_CAPABILITY_PEPPER: secret.optional(), // required at use by guest routes (T06)
    // Keyring (see mediaTokenKeyringSchema); required once the media-tokens endpoint lands.
    MEDIA_TOKEN_SECRET: mediaTokenKeyringSchema.optional(),
    // R2 adapter + bucket policy land in T09; the first caller (upload endpoints) tightens these.
    // Required at use by the upload endpoints (T10); optional here so builds/CI need no secrets.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_ORIGINALS: z.string().default('lumra-originals'),
    // S3 endpoint override for local fakes / jurisdiction endpoints; default is the account endpoint.
    R2_ENDPOINT: url.optional(),
    // HMAC pepper for rate-limit subject keys (FR-A05); falls back to GUEST_CAPABILITY_PEPPER.
    RATE_LIMIT_PEPPER: secret.optional(),
    // Cloudflare Turnstile: bot challenges are enforced only when the secret is set (FR-A05).
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
    STRIPE_SECRET_KEY: z.string().optional(), // required by T29
    STRIPE_WEBHOOK_SECRET: z.string().optional(), // required by T29
    STRIPE_PRICE_PRO_MONTHLY: z.string().optional(), // required by T29
    SENTRY_DSN: url.optional(), // server/edge; absent ⇒ Sentry disabled (T04)
    NEXT_PUBLIC_SENTRY_DSN: url.optional(), // browser; inlined at build time
    SENTRY_ENVIRONMENT: z.string().optional(), // defaults to VERCEL_ENV / NODE_ENV
    VERCEL_GIT_COMMIT_SHA: z.string().optional(), // Sentry release + /api/health `commit`
    VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
    LOG_LEVEL: logLevel.default('info'),
    // Best-effort "kick" to the job worker after an upload finalizes (`POST {WORKER_URL}/internal/
    // relay`), so processing starts within seconds instead of on the next cron relay. Both unset
    // ⇒ no kick; the outbox relay cron still picks the job up.
    WORKER_URL: url.optional(),
    WORKER_KICK_SECRET: secret.optional(),
  })
  .superRefine((env, ctx) => {
    // Deployed environments must have auth configured (T05).
    if (env.VERCEL_ENV !== 'production' && env.VERCEL_ENV !== 'preview') return;
    for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'required on Vercel deployments' });
    }
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
  /** Allowed CORS origins, comma-separated (e.g. `https://www.lumra.photos`). */
  APP_ORIGIN: originListSchema,
  /** Verification keyring; every listed kid is accepted (ADR-001). */
  MEDIA_TOKEN_SECRET: mediaTokenKeyringSchema,
  ...workerObservability,
});
export type MediaGatewayEnv = z.infer<typeof mediaGatewayEnvSchema>;

export const workerEnvSchema = z.object({
  /**
   * Direct Postgres URL for local dev / tests. Deployed environments use the `HYPERDRIVE`
   * binding instead; the worker fails on first DB use if neither is configured (T12).
   */
  DATABASE_URL: url.optional(),
  /**
   * Plain-HTTP image processor for local dev (`http://localhost:8080`). When unset the worker
   * uses the Cloudflare Containers binding `IMAGE_PROCESSOR` (ADR-002).
   */
  PROCESSOR_URL: url.optional(),
  /**
   * Bearer secret for `POST /internal/relay` (immediate outbox relay after an upload finalizes).
   * Same value as the web app's `WORKER_KICK_SECRET`. Unset ⇒ the endpoint fails closed (503).
   */
  WORKER_KICK_SECRET: secret.optional(),
  ...workerObservability,
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Image-processor container (apps/image-processor, ADR-002). */
export const imageProcessorEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type ImageProcessorEnv = z.infer<typeof imageProcessorEnvSchema>;

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
