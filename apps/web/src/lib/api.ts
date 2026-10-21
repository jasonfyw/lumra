import { NextResponse } from 'next/server';
import { API_ERROR_STATUS, type ApiError, type ApiResponse } from '@lumra/contracts';

/** Builders for the `{data, error, requestId}` envelope (PRD §10). */
export function ok<T>(data: T, requestId: string, init?: ResponseInit) {
  return NextResponse.json<ApiResponse<T>>({ data, error: null, requestId }, init);
}

export function fail(error: ApiError, requestId: string, init?: ResponseInit) {
  return NextResponse.json<ApiResponse<never>>(
    { data: null, error, requestId },
    { status: API_ERROR_STATUS[error.code], ...init },
  );
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
