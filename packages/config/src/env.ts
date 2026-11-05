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

export const webServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: url,
  NEXT_PUBLIC_MEDIA_URL: url.optional(), // required by T20
  NEXT_PUBLIC_SUPABASE_URL: url.optional(), // required by T05
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(), // required by T05
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), // required by T02/T06
  DATABASE_URL: url.optional(), // required by T02
  GUEST_CAPABILITY_PEPPER: secret.optional(), // required by T06
  // Keyring (see mediaTokenKeyringSchema); required once the media-tokens endpoint lands.
  MEDIA_TOKEN_SECRET: mediaTokenKeyringSchema.optional(),
  R2_ACCOUNT_ID: z.string().optional(), // required by T09
  R2_ACCESS_KEY_ID: z.string().optional(), // required by T09
  R2_SECRET_ACCESS_KEY: z.string().optional(), // required by T09
  R2_BUCKET_ORIGINALS: z.string().default('lumra-originals'),
  STRIPE_SECRET_KEY: z.string().optional(), // required by T29
  STRIPE_WEBHOOK_SECRET: z.string().optional(), // required by T29
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(), // required by T29
  SENTRY_DSN: url.optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type WebServerEnv = z.infer<typeof webServerEnvSchema>;

export const mediaGatewayEnvSchema = z.object({
  /** Allowed CORS origins, comma-separated (e.g. `https://lumra.vercel.app`). */
  APP_ORIGIN: originListSchema,
  /** Verification keyring; every listed kid is accepted (ADR-001). */
  MEDIA_TOKEN_SECRET: mediaTokenKeyringSchema,
  SENTRY_DSN: url.optional(),
});
export type MediaGatewayEnv = z.infer<typeof mediaGatewayEnvSchema>;

export const workerEnvSchema = z.object({
  DATABASE_URL: url.optional(), // required by T12
  SENTRY_DSN: url.optional(),
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
