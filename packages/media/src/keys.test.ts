import { describe, expect, it } from 'vitest';
import { archivePartKey, assertStorageKey, derivativeKey, isStorageKey, originalKey } from './keys';

const gallery = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
const media = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('storage keys', () => {
  it('builds the documented layout', () => {
    expect(originalKey('guest-abcdef12', gallery, media)).toBe(
      `originals/guest-abcdef12/${gallery}/${media}/source`,
    );
    expect(derivativeKey(gallery, media, 'w640q80')).toBe(
      `derivatives/${gallery}/${media}/w640q80.webp`,
    );
    expect(archivePartKey(gallery, media, 2)).toBe(`archives/${gallery}/${media}/2.zip`);
  });

  it('rejects path traversal and filename-like segments', () => {
    expect(() => originalKey('../etc', gallery, media)).toThrow();
    expect(() => originalKey('owner-123456', gallery, 'IMG 0001.jpg')).toThrow();
    expect(() => archivePartKey(gallery, media, 0)).toThrow();
  });
});

describe('assertStorageKey', () => {
  it('accepts every builder output', () => {
    expect(isStorageKey(originalKey('owner-123456', gallery, media))).toBe(true);
    expect(isStorageKey(derivativeKey(gallery, media, 'w640q80'))).toBe(true);
    expect(isStorageKey(archivePartKey(gallery, media, 12))).toBe(true);
  });

  it('rejects hand-built or traversing keys', () => {
    for (const key of [
      '',
      'originals/../../etc/passwd',
      `originals/owner-123456/${gallery}/${media}/IMG_0001.jpg`,
      `/originals/owner-123456/${gallery}/${media}/source`,
      `originals/owner-123456/${gallery}/${media}/source/`,
      `originals/owner-123456/${gallery}/../${media}/source`,
      `archives/${gallery}/${media}/0.zip`,
      `derivatives/${gallery}/${media}/W640.webp`,
      'public/anything',
    ]) {
      expect(() => assertStorageKey(key)).toThrow();
    }
  });
});
