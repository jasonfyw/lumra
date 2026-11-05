import { NextResponse } from 'next/server';
import { API_ERROR_STATUS, type ApiError, type ApiResponse } from '@lumra/contracts';
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
  type Logger,
} from '@lumra/observability';
import { logger } from './log';

/** Builders for the `{data, error, requestId}` envelope (PRD §10). Both echo `x-request-id`. */
export function ok<T>(data: T, requestId: string, init?: ResponseInit) {
  const res = NextResponse.json<ApiResponse<T>>({ data, error: null, requestId }, init);
  res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

export function fail(error: ApiError, requestId: string, init?: ResponseInit) {
  const res = NextResponse.json<ApiResponse<never>>(
    { data: null, error, requestId },
    { status: API_ERROR_STATUS[error.code], ...init },
  );
  res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

/** The only body ever returned for unexpected failures: no messages, stacks or causes. */
export const INTERNAL_ERROR: ApiError = {
  code: 'internal',
  message: 'An unexpected error occurred.',
  retryable: true,
};

export function internalError(requestId: string) {
  return fail(INTERNAL_ERROR, requestId, { headers: { 'Cache-Control': 'no-store' } });
}

export function newRequestId(): string {
  return generateRequestId();
}

export interface RequestContext {
  requestId: string;
  log: Logger;
}

/** Request ID from a valid inbound `x-request-id` (else a fresh UUID) plus a logger bound to it. */
export function requestContext(request: Request): RequestContext {
  const requestId = resolveRequestId(request);
  return { requestId, log: logger.child({ requestId }) };
}
