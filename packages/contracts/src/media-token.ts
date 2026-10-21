import { z } from 'zod';
import { MEDIA_TOKEN } from '@lumra/config';

/** Claims carried by gateway media tokens (PRD §6.2). Verified by apps/media-gateway. */
export const MEDIA_VARIANTS = ['w320', 'w640', 'w1280', 'w2048', 'original'] as const;
export const MEDIA_ACTIONS = ['preview', 'original', 'archive'] as const;

export const mediaTokenClaimsSchema = z.object({
  aud: z.literal(MEDIA_TOKEN.audience),
  gallery_id: z.uuid(),
  media_id: z.uuid().nullable(),
  archive_part_id: z.uuid().nullable().optional(),
  variant: z.enum(MEDIA_VARIANTS).nullable(),
  action: z.enum(MEDIA_ACTIONS),
  access_version: z.number().int().nonnegative(),
  exp: z.number().int(),
  jti: z.string().min(16),
});
export type MediaTokenClaims = z.infer<typeof mediaTokenClaimsSchema>;
