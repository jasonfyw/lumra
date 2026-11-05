/**
 * Request IDs (PRD §12): every inbound request gets one, it is echoed in the `x-request-id`
 * response header and the `{data, error, requestId}` envelope, and it travels into queue
 * messages as `traceId` so a single ID spans Next.js → Queues → Workers.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** UUIDs and other opaque IDs: safe charset, starts alphanumeric, at most 64 chars. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}

type HeaderSource = Headers | { headers: Headers } | null | undefined;

/**
 * Returns the inbound `x-request-id` when it is well-formed, otherwise a fresh UUID. Untrusted
 * values (overlong, odd characters, header-injection attempts) are discarded, never echoed.
 */
export function resolveRequestId(source?: HeaderSource): string {
  const headers = source instanceof Headers ? source : source?.headers;
  const inbound = headers?.get(REQUEST_ID_HEADER)?.trim();
  return isValidRequestId(inbound) ? inbound : generateRequestId();
}

/**
 * Stamps a queue message with the originating request ID as `traceId` (see
 * `@lumra/contracts` queue schema). An invalid ID is replaced so traces never carry junk.
 *
 * @example
 * const msg = withTraceId({ type: 'media.uploaded', mediaId, dedupeKey }, requestId) satisfies QueueMessage;
 */
export function withTraceId<M extends object>(
  message: M,
  requestId: string,
): M & { traceId: string } {
  return { ...message, traceId: isValidRequestId(requestId) ? requestId : generateRequestId() };
}
