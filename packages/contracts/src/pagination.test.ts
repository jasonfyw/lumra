import { describe, expect, it } from 'vitest';
import {
  claimGuestDraftRequestSchema,
  createGalleryRequestSchema,
  decodeKeysetCursor,
  encodeKeysetCursor,
  galleryListQuerySchema,
  idempotencyKeySchema,
} from './index';

const ID = '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';

describe('keyset cursor', () => {
  it('round-trips microsecond timestamps and ids', () => {
    const cursor = { ts: '2026-11-05T10:11:12.123456Z', id: ID };
    const encoded = encodeKeysetCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeysetCursor(encoded)).toEqual(cursor);
  });

  it('rejects malformed, tampered or oversized cursors', () => {
    expect(decodeKeysetCursor('')).toBeNull();
    expect(decodeKeysetCursor('not a cursor!')).toBeNull();
    expect(decodeKeysetCursor('a'.repeat(300))).toBeNull();
    expect(decodeKeysetCursor(btoa('{"ts":1}'))).toBeNull();
    const badId = encodeKeysetCursor({ ts: '2026-11-05T10:11:12.123456Z', id: 'x' });
    expect(decodeKeysetCursor(badId)).toBeNull();
    const badTs = encodeKeysetCursor({ ts: "1' or 1=1 --", id: ID });
    expect(decodeKeysetCursor(badTs)).toBeNull();
  });
});

describe('gallery contracts', () => {
  it('bounds list limit to 1..100 with a default', () => {
    expect(galleryListQuerySchema.parse({}).limit).toBe(25);
    expect(galleryListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(galleryListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(galleryListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('trims titles and rejects empty or long ones', () => {
    expect(createGalleryRequestSchema.parse({ title: '  Trip  ' })).toEqual({ title: 'Trip' });
    expect(createGalleryRequestSchema.parse({})).toEqual({});
    expect(createGalleryRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(createGalleryRequestSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('validates claim requests and idempotency keys', () => {
    expect(claimGuestDraftRequestSchema.safeParse({ galleryId: ID }).success).toBe(true);
    expect(claimGuestDraftRequestSchema.safeParse({ galleryId: 'abc' }).success).toBe(false);
    expect(idempotencyKeySchema.safeParse(ID).success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has spaces in it').success).toBe(false);
  });
});
