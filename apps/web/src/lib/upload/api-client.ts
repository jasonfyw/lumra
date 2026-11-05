import type {
  ApiErrorCode,
  ApiResponse,
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateGalleryResponse,
  CreateGuestDraftResponse,
  GuestDraftResponse,
  SignedPart,
  SignPartsResponse,
  UploadIntentRequest,
  UploadIntentResponse,
  UploadStateResponse,
} from '@lumra/contracts';
import { parseRetryAfter } from './backoff';

/** Error from a Lumra API call. `network` means no HTTP response was received at all. */
export class UploadApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'UploadApiError';
  }

  /** Worth retrying automatically: no response, a 5xx, or a 429. Conflicts are handled by callers. */
  get transient(): boolean {
    return this.code === 'network' || this.status >= 500 || this.status === 429;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

/**
 * Typed browser client for the upload endpoints (PRD §10, docs/UPLOADS.md). Cookies carry the
 * guest capability / Supabase session, so every call is same-origin with credentials.
 */
export interface UploadApi {
  createIntent(
    galleryId: string,
    body: UploadIntentRequest,
    signal?: AbortSignal,
  ): Promise<{ intent: UploadIntentResponse; created: boolean }>;
  signParts(intentId: string, partNumbers: number[], signal?: AbortSignal): Promise<SignedPart[]>;
  getUpload(intentId: string, signal?: AbortSignal): Promise<UploadStateResponse>;
  complete(
    intentId: string,
    body: CompleteUploadRequest,
    signal?: AbortSignal,
  ): Promise<CompleteUploadResponse>;
  abort(intentId: string): Promise<void>;
  getGuestDraft(signal?: AbortSignal): Promise<GuestDraftResponse>;
  createGuestDraft(signal?: AbortSignal): Promise<CreateGuestDraftResponse>;
  createGallery(
    idempotencyKey: string,
    title?: string,
    signal?: AbortSignal,
  ): Promise<CreateGalleryResponse>;
}

const NETWORK_MESSAGE = 'Network error. Check your connection and try again.';

export function createUploadApi(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  base = '',
): UploadApi {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ data: T; status: number }> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers:
          body === undefined
            ? extraHeaders
            : { 'Content-Type': 'application/json', ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new UploadApiError(0, 'network', NETWORK_MESSAGE, true);
    }
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    let parsed: ApiResponse<T> | null = null;
    try {
      parsed = (await res.json()) as ApiResponse<T>;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    if (parsed?.error) {
      const e = parsed.error;
      throw new UploadApiError(
        res.status,
        e.code,
        e.message,
        e.retryable,
        e.details ?? {},
        retryAfterMs,
      );
    }
    if (!res.ok || !parsed) {
      const status = res.status;
      throw new UploadApiError(
        status,
        status === 429 ? 'rate_limited' : 'internal',
        status === 429
          ? 'Too many requests. Please wait and try again.'
          : 'Something went wrong. Try again.',
        status >= 500 || status === 429,
        {},
        retryAfterMs,
      );
    }
    return { data: parsed.data, status: res.status };
  }

  const enc = encodeURIComponent;
  return {
    async createIntent(galleryId, body, signal) {
      const { data, status } = await call<UploadIntentResponse>(
        'POST',
        `/api/v1/galleries/${enc(galleryId)}/upload-intents`,
        body,
        signal,
      );
      return { intent: data, created: status === 201 };
    },
    async signParts(intentId, partNumbers, signal) {
      const { data } = await call<SignPartsResponse>(
        'POST',
        `/api/v1/uploads/${enc(intentId)}/parts/sign`,
        { partNumbers },
        signal,
      );
      return data.parts;
    },
    async getUpload(intentId, signal) {
      return (
        await call<UploadStateResponse>(
          'GET',
          `/api/v1/uploads/${enc(intentId)}`,
          undefined,
          signal,
        )
      ).data;
    },
    async complete(intentId, body, signal) {
      return (
        await call<CompleteUploadResponse>(
          'POST',
          `/api/v1/uploads/${enc(intentId)}/complete`,
          body,
          signal,
        )
      ).data;
    },
    async abort(intentId) {
      await call<unknown>('POST', `/api/v1/uploads/${enc(intentId)}/abort`, {});
    },
    async getGuestDraft(signal) {
      return (
        await call<GuestDraftResponse>('GET', '/api/v1/guest/drafts/current', undefined, signal)
      ).data;
    },
    async createGuestDraft(signal) {
      return (await call<CreateGuestDraftResponse>('POST', '/api/v1/guest/drafts', {}, signal))
        .data;
    },
    async createGallery(idempotencyKey, title, signal) {
      return (
        await call<CreateGalleryResponse>(
          'POST',
          '/api/v1/galleries',
          title ? { title } : {},
          signal,
          { 'Idempotency-Key': idempotencyKey },
        )
      ).data;
    },
  };
}
