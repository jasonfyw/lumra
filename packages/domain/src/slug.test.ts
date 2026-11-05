import { describe, expect, it } from 'vitest';
import { SLUG_ALPHABET, SLUG_LENGTH, generateSlug, isValidSlug } from './slug';

describe('generateSlug', () => {
  it('produces fixed-length base58 slugs with >= 96 bits of entropy', () => {
    expect(SLUG_LENGTH * Math.log2(SLUG_ALPHABET.length)).toBeGreaterThanOrEqual(96);
    for (let i = 0; i < 200; i++) {
      const slug = generateSlug();
      expect(slug).toHaveLength(SLUG_LENGTH);
      expect(slug).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(isValidSlug(slug)).toBe(true);
    }
  });

  it('excludes ambiguous characters', () => {
    for (const char of '0OIl') expect(SLUG_ALPHABET).not.toContain(char);
    expect(new Set(SLUG_ALPHABET).size).toBe(58);
  });

  it('does not repeat over many draws and uses the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const slug = generateSlug();
      seen.add(slug);
      for (const c of slug) chars.add(c);
    }
    expect(seen.size).toBe(20_000);
    expect(chars.size).toBe(58);
  });

  it('rejects biased bytes (>= 232) instead of wrapping them', () => {
    let call = 0;
    const slug = generateSlug((bytes) => {
      // First fill: all rejected; second fill: all zero -> first alphabet char.
      bytes.fill(call++ === 0 ? 255 : 0);
    });
    expect(slug).toBe(SLUG_ALPHABET[0]!.repeat(SLUG_LENGTH));
    expect(call).toBe(2);
  });
});

describe('isValidSlug', () => {
  it.each([
    '',
    'abc',
    '1'.repeat(SLUG_LENGTH - 1),
    '1'.repeat(SLUG_LENGTH + 1),
    `${'1'.repeat(SLUG_LENGTH - 1)}0`,
    `${'1'.repeat(SLUG_LENGTH - 1)}l`,
    `${'1'.repeat(SLUG_LENGTH - 1)}-`,
    `${'1'.repeat(SLUG_LENGTH - 1)}/`,
    ` ${'1'.repeat(SLUG_LENGTH - 1)}`,
    `${'1'.repeat(SLUG_LENGTH)}\n`,
  ])('rejects %j', (value) => {
    expect(isValidSlug(value)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug(123)).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
  });
});
