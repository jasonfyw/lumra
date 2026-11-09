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

describe('delivery.served queue message', () => {
  it('requires positive integer bytes', () => {
    const msg = {
      type: 'delivery.served',
      galleryId: '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10',
      action: 'preview',
      mediaId: '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      archivePartId: null,
      variant: 'w640',
      bytes: 1024,
      servedAt: '2026-11-05T12:00:00.000Z',
      traceId: 'ray',
      dedupeKey: 'jti:0-1023',
    };
    expect(queueMessageSchema.parse(msg)).toEqual(msg);
    expect(queueMessageSchema.safeParse({ ...msg, bytes: 0 }).success).toBe(false);
    expect(queueMessageSchema.safeParse({ ...msg, bytes: 1.5 }).success).toBe(false);
  });

  it('bounds dedupeKey to the ledger source_id length (1–200)', () => {
    const msg = {
      type: 'delivery.served',
      galleryId: '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10',
      action: 'preview',
      mediaId: '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      archivePartId: null,
      variant: 'w640',
      bytes: 1024,
      servedAt: '2026-11-05T12:00:00.000Z',
      traceId: 'ray',
    };
    expect(queueMessageSchema.safeParse({ ...msg, dedupeKey: 'k'.repeat(200) }).success).toBe(true);
    expect(queueMessageSchema.safeParse({ ...msg, dedupeKey: 'k'.repeat(201) }).success).toBe(
      false,
    );
    expect(queueMessageSchema.safeParse({ ...msg, dedupeKey: '' }).success).toBe(false);
  });
});
