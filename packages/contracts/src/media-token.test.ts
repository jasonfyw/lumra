import { describe, expect, it } from 'vitest';
import { galleryAccessStateSchema, mediaTokenClaimsSchema, queueMessageSchema } from './index';

describe('mediaTokenClaimsSchema', () => {
  const common = {
    aud: 'lumra-media',
    gallery_id: '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10',
    access_version: 0,
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    jti: 'abcdefghijklmnop',
  };
  const media_id = '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
  const ok = (v: unknown) => mediaTokenClaimsSchema.safeParse(v).success;

  it('requires the storage-key segments for each action', () => {
    const preview = {
      ...common,
      action: 'preview',
      media_id,
      variant: 'w320',
      variant_hash: 'abcd',
    };
    expect(ok(preview)).toBe(true);
    expect(ok({ ...preview, variant: 'original' })).toBe(false);

    const original = { ...common, action: 'original', media_id, variant: 'original' };
    expect(ok(original)).toBe(false);
    expect(ok({ ...original, owner_ref: '../../etc' })).toBe(false);
    expect(ok({ ...original, owner_ref: 'owner-1234abcd' })).toBe(true);

    const archive = { ...common, action: 'archive', archive_part_id: media_id, archive_part_no: 1 };
    expect(ok(archive)).toBe(false);
    expect(ok({ ...archive, archive_job_id: media_id })).toBe(true);
  });

  it('requires aud and a jti', () => {
    const preview = {
      ...common,
      action: 'preview',
      media_id,
      variant: 'w320',
      variant_hash: 'abcd',
    };
    expect(ok({ ...preview, aud: 'other' })).toBe(false);
    expect(ok({ ...preview, jti: 'short' })).toBe(false);
  });
});

describe('galleryAccessStateSchema', () => {
  it('accepts the KV payload and rejects partial documents', () => {
    const state = {
      accessVersion: 1,
      deleted: false,
      expiresAt: '2026-12-01T00:00:00Z',
      deliverySuspended: false,
      updatedAt: '2026-11-05T00:00:00.000Z',
    };
    expect(galleryAccessStateSchema.parse(state)).toEqual(state);
    expect(galleryAccessStateSchema.safeParse({ accessVersion: 1 }).success).toBe(false);
  });
});

describe('queue messages', () => {
  it('rejects the retired delivery.served usage event (ADR-008)', () => {
    const msg = {
      type: 'delivery.served',
      galleryId: '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10',
      bytes: 1024,
      traceId: 'ray',
      dedupeKey: 'jti:0-1023',
    };
    expect(queueMessageSchema.safeParse(msg).success).toBe(false);
  });
});
