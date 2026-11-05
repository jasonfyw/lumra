import { describe, expect, it } from 'vitest';
import {
  generateGuestCapability,
  guestCookieOptions,
  hashGuestCapability,
  isWellFormedCapability,
} from './guest-capability';

describe('guest capability', () => {
  it('generates 256-bit URL-safe capabilities', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const cap = generateGuestCapability();
      expect(isWellFormedCapability(cap)).toBe(true);
      seen.add(cap);
    }
    expect(seen.size).toBe(200);
  });

  it('rejects malformed cookie values', () => {
    expect(isWellFormedCapability(undefined)).toBe(false);
    expect(isWellFormedCapability('short')).toBe(false);
    expect(isWellFormedCapability('a'.repeat(42) + '!')).toBe(false);
  });

  it('hashes deterministically per pepper', async () => {
    const cap = generateGuestCapability();
    const a = await hashGuestCapability(cap, 'p'.repeat(32));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashGuestCapability(cap, 'p'.repeat(32))).toBe(a);
    expect(await hashGuestCapability(cap, 'q'.repeat(32))).not.toBe(a);
  });

  it('uses HttpOnly SameSite=Lax cookies', () => {
    const expires = new Date('2026-11-06T00:00:00Z');
    expect(guestCookieOptions(expires, true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires,
    });
  });
});
