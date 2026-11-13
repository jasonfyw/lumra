import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv, webServerEnvSchema, workerEnvSchema } from './env';

describe('parseEnv', () => {
  it('applies defaults for a minimal valid env', () => {
    const env = parseEnv('web', webServerEnvSchema, {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    });
    expect(env.NODE_ENV).toBe('development');
    expect(env.R2_BUCKET_ORIGINALS).toBe('lumra-originals');
  });

  it('reports every invalid key in a readable error', () => {
    expect(() =>
      parseEnv('web', webServerEnvSchema, {
        NEXT_PUBLIC_APP_URL: 'nope',
        MEDIA_TOKEN_SECRET: 'short',
      }),
    ).toThrowError(EnvValidationError);

    try {
      parseEnv('web', webServerEnvSchema, {
        NEXT_PUBLIC_APP_URL: 'nope',
        MEDIA_TOKEN_SECRET: 'short',
      });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('NEXT_PUBLIC_APP_URL');
      expect(message).toContain('MEDIA_TOKEN_SECRET');
      expect(message).not.toContain('short'); // never echo secret values
    }
  });

  it('requires Supabase auth config on Vercel deployments only (T05)', () => {
    const base = { NEXT_PUBLIC_APP_URL: 'https://lumra.test' };
    expect(() => parseEnv('web', webServerEnvSchema, base)).not.toThrow();
    expect(() =>
      parseEnv('web', webServerEnvSchema, { ...base, VERCEL_ENV: 'development' }),
    ).not.toThrow();
    for (const VERCEL_ENV of ['production', 'preview']) {
      expect(() => parseEnv('web', webServerEnvSchema, { ...base, VERCEL_ENV })).toThrowError(
        /NEXT_PUBLIC_SUPABASE_URL[\s\S]*NEXT_PUBLIC_SUPABASE_ANON_KEY/,
      );
      expect(() =>
        parseEnv('web', webServerEnvSchema, {
          ...base,
          VERCEL_ENV,
          NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
        }),
      ).not.toThrow();
    }
  });

  it('validates Stripe keys without echoing them; empty values mean unset (T29)', () => {
    const base = { NEXT_PUBLIC_APP_URL: 'http://localhost:3000' };
    const ok = parseEnv('web', webServerEnvSchema, {
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_51Abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
    });
    expect(ok.STRIPE_SECRET_KEY).toBe('sk_test_51Abc');
    const empty = parseEnv('web', webServerEnvSchema, {
      ...base,
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
    });
    expect(empty.STRIPE_SECRET_KEY).toBeUndefined();
    expect(empty.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    try {
      parseEnv('web', webServerEnvSchema, {
        ...base,
        STRIPE_SECRET_KEY: 'pk_live_notasecretkey',
        STRIPE_WEBHOOK_SECRET: 'nope-secret-value',
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('STRIPE_SECRET_KEY');
      expect(message).toContain('STRIPE_WEBHOOK_SECRET');
      expect(message).not.toContain('pk_live_notasecretkey');
      expect(message).not.toContain('nope-secret-value');
    }
  });

  it('accepts the optional worker kick settings and rejects short kick secrets', () => {
    const secret = 'k'.repeat(32);
    const web = parseEnv('web', webServerEnvSchema, {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      WORKER_URL: 'https://lumra-worker.example.workers.dev',
      WORKER_KICK_SECRET: secret,
    });
    expect(web.WORKER_URL).toBe('https://lumra-worker.example.workers.dev');
    expect(parseEnv('worker', workerEnvSchema, { WORKER_KICK_SECRET: secret })).toMatchObject({
      WORKER_KICK_SECRET: secret,
    });
    expect(parseEnv('worker', workerEnvSchema, {}).WORKER_KICK_SECRET).toBeUndefined();
    expect(() => parseEnv('worker', workerEnvSchema, { WORKER_KICK_SECRET: 'short' })).toThrow(
      /WORKER_KICK_SECRET/,
    );
    expect(() =>
      parseEnv('web', webServerEnvSchema, {
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        WORKER_URL: 'not a url',
      }),
    ).toThrow(/WORKER_URL/);
  });
});
