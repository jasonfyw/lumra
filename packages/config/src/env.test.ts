import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv, webServerEnvSchema } from './env';

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
});
