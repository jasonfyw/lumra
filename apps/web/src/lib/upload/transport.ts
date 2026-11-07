import { parseRetryAfter } from './backoff';

export interface PutRequest {
  /** Presigned URL: a bearer credential. Never log or persist it. */
  url: string;
  headers: Record<string, string>;
  body: Blob;
  signal: AbortSignal;
  onProgress: (loadedBytes: number) => void;
  timeoutMs: number;
}

export interface PutResult {
  /** HTTP status; 0 when no response arrived (network error, CORS failure, timeout). */
  status: number;
  /** `ETag` response header (exposed by the bucket CORS rule), or null. */
  etag: string | null;
  retryAfterMs: number | null;
}

/** PUT of one part/object straight to R2. Rejects only with an `AbortError`. */
export type PutTransport = (request: PutRequest) => Promise<PutResult>;

// Browsers compute these from the body; scripts may not set them.
const FORBIDDEN = new Set(['content-length', 'host']);

/**
 * XMLHttpRequest transport: `fetch` has no upload progress events, and per-byte progress is part
 * of the upload UI contract (PRD §4).
 */
export const xhrTransport: PutTransport = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', request.url, true);
    xhr.timeout = request.timeoutMs;
    for (const [name, value] of Object.entries(request.headers)) {
      if (!FORBIDDEN.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => request.onProgress(event.loaded);
    const onAbort = () => xhr.abort();
    const cleanup = () => request.signal.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      cleanup();
      resolve({
        status: xhr.status,
        etag: xhr.getResponseHeader('ETag'),
        retryAfterMs: parseRetryAfter(xhr.getResponseHeader('Retry-After')),
      });
    };
    const failed = () => {
      cleanup();
      resolve({ status: 0, etag: null, retryAfterMs: null });
    };
    xhr.onerror = failed;
    xhr.ontimeout = failed;
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    xhr.send(request.body);
  });
