import { z } from 'zod';
import { MEDIA_TOKEN } from '@lumra/config';

/**
 * Claims carried by gateway media tokens (PRD §6.2, ADR-001). Minted by the web app's
 * `media-tokens` endpoint, verified by apps/media-gateway via `@lumra/tokens`.
 *
 * The token carries every storage-key segment the gateway needs, so the gateway never
 * consults the database: `variant_hash` for derivatives, `owner_ref` for originals and
 * `archive_job_id`/`archive_part_no` for archive parts. Keys are rebuilt with the
 * `@lumra/media` key builders, which also re-validate each segment.
 */
export const MEDIA_VARIANTS = ['w320', 'w640', 'w1280', 'w2048', 'original'] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];
export const PREVIEW_VARIANTS = ['w320', 'w640', 'w1280', 'w2048'] as const;
export const MEDIA_ACTIONS = ['preview', 'original', 'archive'] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

/** Max length of the download filename claim; the gateway sanitizes it further. */
export const MEDIA_TOKEN_FILENAME_MAX = 255;

/** Same alphabet as `@lumra/media` storage-key segments. */
const keySegment = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

const common = {
  aud: z.literal(MEDIA_TOKEN.audience),
  gallery_id: z.uuid(),
  access_version: z.number().int().nonnegative(),
  /** Issued-at / expiry, epoch seconds. `exp - iat` ≤ MEDIA_TOKEN.maxTtlSeconds. */
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  /** Unique token id; also the usage-event dedupe key prefix. */
  jti: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
};

const filename = z.string().min(1).max(MEDIA_TOKEN_FILENAME_MAX);

export const previewTokenClaimsSchema = z.object({
  ...common,
  action: z.literal('preview'),
  media_id: z.uuid(),
  variant: z.enum(PREVIEW_VARIANTS),
  /** Derivative key segment: `derivatives/{gallery}/{media}/{variant_hash}.webp`. */
  variant_hash: z.string().regex(/^[a-z0-9]{4,64}$/),
});

export const originalTokenClaimsSchema = z.object({
  ...common,
  action: z.literal('original'),
  media_id: z.uuid(),
  variant: z.literal('original'),
  /** Owner segment of `originals/{owner_ref}/{gallery}/{media}/source` (opaque, not a user id). */
  owner_ref: keySegment,
  /** Suggested download filename (user-supplied at upload; sanitized by the gateway). */
  filename: filename.optional(),
});

export const archiveTokenClaimsSchema = z.object({
  ...common,
  action: z.literal('archive'),
  /** `archive_parts.id`, used for usage accounting. */
  archive_part_id: z.uuid(),
  /** Key segments of `archives/{gallery}/{job}/{part_no}.zip`. */
  archive_job_id: z.uuid(),
  archive_part_no: z.number().int().min(1).max(10_000),
  filename: filename.optional(),
});

export const mediaTokenClaimsSchema = z.discriminatedUnion('action', [
  previewTokenClaimsSchema,
  originalTokenClaimsSchema,
  archiveTokenClaimsSchema,
]);
export type MediaTokenClaims = z.infer<typeof mediaTokenClaimsSchema>;
export type PreviewTokenClaims = z.infer<typeof previewTokenClaimsSchema>;
export type OriginalTokenClaims = z.infer<typeof originalTokenClaimsSchema>;
export type ArchiveTokenClaims = z.infer<typeof archiveTokenClaimsSchema>;

/** JWS protected header. Only HS256 is accepted; `kid` selects the keyring entry. */
export const mediaTokenHeaderSchema = z.object({
  alg: z.literal('HS256'),
  typ: z.literal('JWT').optional(),
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
});
export type MediaTokenHeader = z.infer<typeof mediaTokenHeaderSchema>;
