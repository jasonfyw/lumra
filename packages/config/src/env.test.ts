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
});
