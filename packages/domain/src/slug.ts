/**
 * Public gallery slugs (FR-G01, FR-V01). Slugs are random, unguessable and carry no PII:
 * they are never derived from titles or filenames, so renaming a gallery keeps the URL stable.
 *
 * Base58 (Bitcoin alphabet: no `0`, `O`, `I`, `l`) × 17 chars ≈ 99.6 bits of entropy (≥ 96).
 */
export const SLUG_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const SLUG_LENGTH = 17;

const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);
// Largest multiple of 58 that fits in a byte; bytes ≥ this are rejected to avoid modulo bias.
const REJECTION_LIMIT = 256 - (256 % SLUG_ALPHABET.length);

/** Fills the buffer with random bytes; injectable for tests. */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => void;
const defaultRandom: RandomFill = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** Generates a fresh slug using `crypto.getRandomValues` (Workers, browsers and Node ≥ 19). */
export function generateSlug(random: RandomFill = defaultRandom): string {
  let slug = '';
  const buffer = new Uint8Array(SLUG_LENGTH * 2);
  while (slug.length < SLUG_LENGTH) {
    random(buffer);
    for (const byte of buffer) {
      if (byte >= REJECTION_LIMIT) continue;
      slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      if (slug.length === SLUG_LENGTH) break;
    }
  }
  return slug;
}

/** Cheap syntactic check, e.g. to 404 malformed `/g/[slug]` requests before hitting the DB. */
export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}
