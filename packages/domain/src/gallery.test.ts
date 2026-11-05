import { describe, expect, it } from 'vitest';
import { checkGalleryExpiry, gallerySharePath, MAX_GALLERY_EXPIRY_MS } from './gallery';

describe('checkGalleryExpiry', () => {
  const now = new Date('2026-11-05T12:00:00Z');

  it('accepts null (never expires) and future instants', () => {
    expect(checkGalleryExpiry(null, now)).toEqual({ ok: true });
    expect(checkGalleryExpiry(new Date('2026-11-05T12:00:01Z'), now)).toEqual({ ok: true });
    expect(checkGalleryExpiry(new Date(now.getTime() + MAX_GALLERY_EXPIRY_MS), now)).toEqual({
      ok: true,
    });
  });

  it('rejects now, the past, invalid dates and the far future', () => {
    expect(checkGalleryExpiry(now, now)).toEqual({ ok: false, reason: 'in_past' });
    expect(checkGalleryExpiry(new Date('2020-01-01T00:00:00Z'), now)).toEqual({
      ok: false,
      reason: 'in_past',
    });
    expect(checkGalleryExpiry(new Date('nope'), now)).toEqual({ ok: false, reason: 'in_past' });
    expect(checkGalleryExpiry(new Date(now.getTime() + MAX_GALLERY_EXPIRY_MS + 1), now)).toEqual({
      ok: false,
      reason: 'too_far',
    });
  });
});

describe('gallerySharePath', () => {
  it('builds the stable public path', () => {
    expect(gallerySharePath('Ab3_x-9QwErTy')).toBe('/g/Ab3_x-9QwErTy');
  });
});
