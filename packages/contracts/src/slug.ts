import { z } from 'zod';

/**
 * Public gallery slug format (FR-G01, FR-V01, ADR-010). Base58 (Bitcoin alphabet: no `0`, `O`,
 * `I`, `l`). New galleries get 8 characters; the 17-character slugs issued before ADR-010 are
 * legacy but stay valid forever. Nothing else is accepted.
 */
export const SLUG_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Length of newly generated slugs (~46.9 bits). */
export const SLUG_LENGTH = 8;
/** Length of slugs generated before ADR-010 (~99.6 bits); never regenerated, always accepted. */
export const LEGACY_SLUG_LENGTH = 17;

const SLUG_PATTERN = new RegExp(
  `^(?:[${SLUG_ALPHABET}]{${SLUG_LENGTH}}|[${SLUG_ALPHABET}]{${LEGACY_SLUG_LENGTH}})$`,
);

/** `true` for an 8-char (current) or 17-char (legacy) base58 slug. */
export function isSlugShape(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export const gallerySlugSchema = z.string().refine(isSlugShape, 'Invalid gallery slug');
