import { NextResponse } from 'next/server';
import type { z } from 'zod';
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

/**
 * An expected API error thrown from deep inside a handler or service (e.g. inside a DB
 * transaction, which it also rolls back). `withRoute` turns it into the error envelope.
 */
export class ApiFailure extends Error {
  constructor(
    readonly error: ApiError,
    readonly headers: Record<string, string> = {},
  ) {
    super(`${error.code}: ${error.message}`);
    this.name = 'ApiFailure';
  }
}

export const notFoundError = (message = 'Not found.'): ApiFailure =>
  new ApiFailure({ code: 'not_found', message, retryable: false });

export const validationError = (details?: Record<string, unknown>): ApiFailure =>
  new ApiFailure({
    code: 'validation_failed',
    message: 'The request is invalid.',
    retryable: false,
    ...(details ? { details } : {}),
  });

/** Parses a JSON body with a Zod schema; malformed JSON or schema errors become a 422. */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  const text = await request.text();
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw validationError({ body: 'Malformed JSON.' });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationError({
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
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
