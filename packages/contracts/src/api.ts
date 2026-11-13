import { z } from 'zod';

/** Error codes shared by all API responses (PRD §10). */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'validation_failed',
  'rate_limited',
  'quota_exceeded',
  'spend_cap_reached',
  /** Public gallery whose `expires_at` has passed (PRD J4); distinct from not-found. */
  'gallery_expired',
  /** Password-protected gallery without a valid gallery session (FR-V01). */
  'password_required',
  /** Wrong gallery password (FR-G04). */
  'invalid_password',
  /**
   * Public gallery whose delivery is paused (owner's Free delivery cap or spending cap reached,
   * or billing suspension, PRD §9.4): a calm "temporarily unavailable" notice, never a 500.
   */
  'gallery_unavailable',
  /** Payments are not configured on this deployment (Stripe env unset, T29). */
  'billing_unavailable',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  validation_failed: 422,
  rate_limited: 429,
  quota_exceeded: 403,
  spend_cap_reached: 402,
  gallery_expired: 410,
  password_required: 401,
  invalid_password: 401,
  gallery_unavailable: 503,
  billing_unavailable: 503,
  internal: 500,
};

export const apiErrorSchema = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export type ApiResponse<T> =
  { data: T; error: null; requestId: string } | { data: null; error: ApiError; requestId: string };

export const cursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
