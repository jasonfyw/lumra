import { describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  mediaGatewayEnvSchema,
  mediaTokenKeyringSchema,
  parseEnv,
} from './env';

describe('mediaTokenKeyringSchema', () => {
  const a = 'a'.repeat(32);
  const b = 'b'.repeat(40);

  it('parses kid:secret lists with the first entry active', () => {
    const ring = mediaTokenKeyringSchema.parse(`k2:${b}, k1:${a}`);
    expect(ring.activeKid).toBe('k2');
    expect([...ring.keys.keys()]).toEqual(['k2', 'k1']);
    expect(ring.keys.get('k1')).toBe(a);
  });

  it('accepts a bare secret as kid "default"', () => {
    expect(mediaTokenKeyringSchema.parse(a).activeKid).toBe('default');
  });

  it.each(['k1:short', `bad kid:${a}`, `k1:${a},k1:${b}`, '', ' , '])(
    'rejects %j without echoing secrets',
    (raw) => {
      const result = mediaTokenKeyringSchema.safeParse(raw);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(a);
    },
  );
});

describe('mediaGatewayEnvSchema', () => {
  const secret = `k1:${'x'.repeat(32)}`;

  it('normalizes the origin list', () => {
    const env = parseEnv('media-gateway', mediaGatewayEnvSchema, {
      APP_ORIGIN: 'https://lumra.vercel.app/, http://localhost:3000',
      MEDIA_TOKEN_SECRET: secret,
    });
    expect(env.APP_ORIGIN).toEqual(['https://lumra.vercel.app', 'http://localhost:3000']);
  });

  it('requires the keyring and rejects non-http origins', () => {
    expect(() =>
      parseEnv('media-gateway', mediaGatewayEnvSchema, { APP_ORIGIN: 'https://lumra.vercel.app' }),
    ).toThrowError(EnvValidationError);
    expect(() =>
      parseEnv('media-gateway', mediaGatewayEnvSchema, {
        APP_ORIGIN: 'javascript:alert(1)',
        MEDIA_TOKEN_SECRET: secret,
      }),
    ).toThrowError(EnvValidationError);
  });
});
