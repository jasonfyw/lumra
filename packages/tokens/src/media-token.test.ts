import { describe, expect, it } from 'vitest';
import { MEDIA_TOKEN, mediaTokenKeyringSchema } from '@lumra/config';
import { encodeBase64Url, encodeJsonBase64Url } from './base64url';
import {
  signMediaToken,
  timingSafeEqual,
  verifyMediaToken,
  type MediaTokenInput,
} from './media-token';

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);
const ring = (raw: string) => mediaTokenKeyringSchema.parse(raw);
const keyringA = ring(`k1:${SECRET_A}`);
const NOW = new Date('2026-11-05T12:00:00Z');
const NOW_S = NOW.getTime() / 1000;
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);

const preview: MediaTokenInput = {
  action: 'preview',
  gallery_id: '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10',
  media_id: '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  variant: 'w640',
  variant_hash: 'w640v1',
  access_version: 3,
};

async function hs256(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return encodeBase64Url(new Uint8Array(sig));
}

/** Builds an arbitrary (possibly invalid) token signed with `secret` (or unsigned). */
async function forge(header: unknown, payload: unknown, secret: string | null = SECRET_A) {
  const input = `${encodeJsonBase64Url(header)}.${encodeJsonBase64Url(payload)}`;
  return `${input}.${secret === null ? '' : await hs256(secret, input)}`;
}

const validPayload = () => ({
  ...preview,
  aud: MEDIA_TOKEN.audience,
  iat: NOW_S,
  exp: NOW_S + 60,
  jti: 'abcdefghijklmnop',
});

describe('signMediaToken / verifyMediaToken', () => {
  it('round-trips claims with aud/iat/exp/jti filled in', async () => {
    const token = await signMediaToken(preview, keyringA, { now: NOW });
    const result = await verifyMediaToken(token, keyringA, { now: NOW });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.kid).toBe('k1');
    expect(result.claims).toMatchObject({ ...preview, aud: 'lumra-media', iat: NOW_S });
    expect(result.claims.exp).toBe(NOW_S + MEDIA_TOKEN.maxTtlSeconds);
    expect(result.claims.jti).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('issues unique jti values', async () => {
    const a = await signMediaToken(preview, keyringA, { now: NOW });
    const b = await signMediaToken(preview, keyringA, { now: NOW });
    expect(a).not.toBe(b);
  });

  it('refuses to sign a TTL above the maximum or invalid claims', async () => {
    await expect(
      signMediaToken(preview, keyringA, { now: NOW, ttlSeconds: MEDIA_TOKEN.maxTtlSeconds + 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      signMediaToken({ ...preview, gallery_id: 'nope' }, keyringA, { now: NOW }),
    ).rejects.toThrow();
  });

  it('signs original and archive tokens with their key segments', async () => {
    const original = await signMediaToken(
      {
        action: 'original',
        gallery_id: preview.gallery_id,
        media_id: '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
        variant: 'original',
        owner_ref: 'owner-1234abcd',
        filename: 'IMG_0001.HEIC',
        access_version: 0,
      },
      keyringA,
      { now: NOW },
    );
    expect((await verifyMediaToken(original, keyringA, { now: NOW })).status).toBe('ok');
    const archive = await signMediaToken(
      {
        action: 'archive',
        gallery_id: preview.gallery_id,
        archive_part_id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
        archive_job_id: '1a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d',
        archive_part_no: 2,
        access_version: 0,
      },
      keyringA,
      { now: NOW },
    );
    expect((await verifyMediaToken(archive, keyringA, { now: NOW })).status).toBe('ok');
  });

  describe('expiry', () => {
    it('accepts within skew and rejects after exp + skew', async () => {
      const token = await signMediaToken(preview, keyringA, { now: NOW, ttlSeconds: 60 });
      expect((await verifyMediaToken(token, keyringA, { now: at(60) })).status).toBe('ok');
      expect((await verifyMediaToken(token, keyringA, { now: at(89) })).status).toBe('ok');
      expect((await verifyMediaToken(token, keyringA, { now: at(90) })).status).toBe('expired');
      expect((await verifyMediaToken(token, keyringA, { now: at(3600) })).status).toBe('expired');
    });

    it('rejects tokens whose lifetime exceeds the maximum', async () => {
      const tooLong = await forge(
        { alg: 'HS256', kid: 'k1' },
        { ...validPayload(), exp: NOW_S + MEDIA_TOKEN.maxTtlSeconds + 1 },
      );
      expect((await verifyMediaToken(tooLong, keyringA, { now: NOW })).status).toBe('malformed');
      // A long exp with a forward-dated iat still exceeds `exp - now`.
      const futureIat = await forge(
        { alg: 'HS256', kid: 'k1' },
        { ...validPayload(), iat: NOW_S + 3600, exp: NOW_S + 3700 },
      );
      expect((await verifyMediaToken(futureIat, keyringA, { now: NOW })).status).toBe('malformed');
    });
  });

  describe('tampering', () => {
    it('rejects a modified payload', async () => {
      const token = await signMediaToken(preview, keyringA, { now: NOW });
      const [h, , s] = token.split('.');
      const evil = encodeJsonBase64Url({ ...validPayload(), access_version: 99 });
      expect((await verifyMediaToken(`${h}.${evil}.${s}`, keyringA, { now: NOW })).status).toBe(
        'bad_signature',
      );
    });

    it('rejects a flipped signature bit and a truncated signature', async () => {
      const token = await signMediaToken(preview, keyringA, { now: NOW });
      const last = token.at(-2) === 'A' ? 'B' : 'A';
      const flipped = `${token.slice(0, -2)}${last}${token.at(-1)}`;
      expect(['bad_signature', 'malformed']).toContain(
        (await verifyMediaToken(flipped, keyringA, { now: NOW })).status,
      );
      expect(['bad_signature', 'malformed']).toContain(
        (await verifyMediaToken(token.slice(0, -4), keyringA, { now: NOW })).status,
      );
    });

    it('rejects a token signed with another secret', async () => {
      const token = await signMediaToken(preview, ring(`k1:${SECRET_B}`), { now: NOW });
      expect((await verifyMediaToken(token, keyringA, { now: NOW })).status).toBe('bad_signature');
    });

    it('rejects structural garbage', async () => {
      for (const bad of ['', 'a.b', 'a.b.c.d', '..', 'x'.repeat(5000), '!!!.???.***']) {
        expect((await verifyMediaToken(bad, keyringA, { now: NOW })).status).toBe('malformed');
      }
    });
  });

  describe('algorithm confusion', () => {
    it.each([
      [{ alg: 'none', kid: 'k1' }, null],
      [{ alg: 'none', kid: 'k1' }, SECRET_A],
      [{ alg: 'RS256', kid: 'k1' }, SECRET_A],
      [{ alg: 'HS512', kid: 'k1' }, SECRET_A],
      [{ alg: 'hs256', kid: 'k1' }, SECRET_A],
      [{ alg: 'HS256' }, SECRET_A],
      [{ alg: 'HS256', kid: 'k1', crit: ['exp'] }, SECRET_A],
    ])('rejects header %j', async (header, secret) => {
      const token = await forge(header, validPayload(), secret);
      expect((await verifyMediaToken(token, keyringA, { now: NOW })).status).toBe('malformed');
    });
  });

  describe('claims', () => {
    it('reports wrong audience', async () => {
      const token = await forge({ alg: 'HS256', kid: 'k1' }, { ...validPayload(), aud: 'other' });
      expect((await verifyMediaToken(token, keyringA, { now: NOW })).status).toBe('wrong_audience');
    });

    it('requires jti and the action-specific key segments', async () => {
      const header = { alg: 'HS256', kid: 'k1' };
      const noJti: Record<string, unknown> = validPayload();
      delete noJti.jti;
      const noHash: Record<string, unknown> = validPayload();
      delete noHash.variant_hash;
      for (const payload of [noJti, noHash, { ...validPayload(), action: 'original' }]) {
        const token = await forge(header, payload);
        expect((await verifyMediaToken(token, keyringA, { now: NOW })).status).toBe('malformed');
      }
    });
  });

  describe('key rotation', () => {
    it('verifies tokens from every key in the ring and signs with the first', async () => {
      const oldRing = ring(`k1:${SECRET_A}`);
      const rotated = ring(`k2:${SECRET_B},k1:${SECRET_A}`);
      const oldToken = await signMediaToken(preview, oldRing, { now: NOW });
      const newToken = await signMediaToken(preview, rotated, { now: NOW });

      const fromOld = await verifyMediaToken(oldToken, rotated, { now: NOW });
      const fromNew = await verifyMediaToken(newToken, rotated, { now: NOW });
      expect(fromOld.status === 'ok' && fromOld.kid).toBe('k1');
      expect(fromNew.status === 'ok' && fromNew.kid).toBe('k2');

      // After the old key is retired, its tokens stop verifying.
      expect((await verifyMediaToken(oldToken, ring(`k2:${SECRET_B}`), { now: NOW })).status).toBe(
        'bad_signature',
      );
    });

    it('does not let a token pick a different key by kid', async () => {
      const rotated = ring(`k2:${SECRET_B},k1:${SECRET_A}`);
      const token = await forge({ alg: 'HS256', kid: 'k2' }, validPayload(), SECRET_A);
      expect((await verifyMediaToken(token, rotated, { now: NOW })).status).toBe('bad_signature');
    });
  });
});

describe('timingSafeEqual', () => {
  it('compares bytes', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
