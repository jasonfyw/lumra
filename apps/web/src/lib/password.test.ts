import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { hashGalleryPassword, verifyGalleryPassword } = await import('./password');

describe('gallery password hashing', () => {
  it('produces salted Argon2id PHC strings that verify', async () => {
    const a = await hashGalleryPassword('wedding-2026');
    const b = await hashGalleryPassword('wedding-2026');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyGalleryPassword('wedding-2026', a)).toBe(true);
    expect(await verifyGalleryPassword('wedding-2027', a)).toBe(false);
  });

  it('normalises Unicode and denies malformed hashes', async () => {
    const hash = await hashGalleryPassword('café');
    expect(await verifyGalleryPassword('café', hash)).toBe(true);
    expect(await verifyGalleryPassword('x', 'not-a-hash')).toBe(false);
  });
});
