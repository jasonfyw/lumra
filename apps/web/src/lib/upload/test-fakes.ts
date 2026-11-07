/**
 * Test doubles for the upload engine: an in-memory Lumra upload API (intents, signing, state,
 * complete, abort, guest quota) and a fake R2 transport that "stores" parts and can be told to
 * fail. Used by engine and component tests only.
 */
import type {
  GuestDraftResponse,
  MediaStatus,
  SignedPart,
  UploadIntentResponse,
  UploadStateResponse,
} from '@lumra/contracts';
import { GUEST_LIMITS } from '@lumra/config';
import { partLength, planUpload, type UploadPlan } from '@lumra/media';
import { UploadApiError, type UploadApi } from './api-client';
import type { PutRequest, PutResult, PutTransport } from './transport';

export const JPEG_PREFIX = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00,
  // SOF0: length 17, precision 8, height 0x0010, width 0x0020, 3 components
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
  0x03, 0x11, 0x01,
]);

/** A `File` whose `size` is `size` but whose bytes are only materialised lazily (sparse). */
export function photo(name: string, size: number, lastModified = 1_700_000_000_000): File {
  const body = new Uint8Array(Math.min(size, 64));
  body.set(JPEG_PREFIX.subarray(0, Math.min(JPEG_PREFIX.length, body.length)));
  // Pad with a zero-filled blob so `size` matches without allocating 50 MB per test.
  const parts: BlobPart[] = [body];
  if (size > body.length) parts.push(new Blob([new Uint8Array(size - body.length)]));
  return new File(parts, name, { type: 'image/jpeg', lastModified });
}

/** Reads the prefix without touching jsdom's slow Blob reader. */
export const readPrefix = async () => JPEG_PREFIX;

interface FakeIntent {
  intentId: string;
  mediaId: string;
  clientId: string;
  filename: string;
  size: number;
  plan: UploadPlan;
  status: 'pending' | 'completed' | 'aborted' | 'expired';
  mediaStatus: MediaStatus;
  parts: Map<number, { etag: string; size: number }>;
}

type Failure = UploadApiError | Error;

let counter = 0;
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export class FakeLumra {
  readonly galleryId = uuid();
  readonly intents = new Map<string, FakeIntent>();
  readonly byClient = new Map<string, FakeIntent>();
  readonly calls: string[] = [];
  quota = { reservedFiles: 0, reservedBytes: 0 };
  guest = true;
  /** Queue of failures to throw from the next matching API call. */
  failNext: Partial<Record<keyof UploadApi, Failure[]>> = {};
  /** Part PUT outcomes to force, consumed in order: e.g. [{status: 500}]. */
  putFailures: Partial<PutResult>[] = [];
  /** Optional hook to observe/delay PUTs. */
  onPut: ((request: PutRequest, url: URL) => Promise<void> | void) | null = null;
  activePuts = 0;
  maxActivePuts = 0;
  putCount = 0;

  private takeFailure(method: keyof UploadApi): void {
    const queue = this.failNext[method];
    const failure = queue?.shift();
    if (failure) throw failure;
  }

  readonly api: UploadApi = {
    createIntent: async (galleryId, body) => {
      this.calls.push(`intent:${body.filename}`);
      this.takeFailure('createIntent');
      if (galleryId !== this.galleryId) throw apiError(404, 'not_found', 'Not found.');
      const existing = this.byClient.get(body.clientId);
      if (existing) return { intent: this.intentDto(existing), created: false };
      if (this.guest) {
        if (this.quota.reservedFiles + 1 > GUEST_LIMITS.maxFiles) {
          throw apiError(
            403,
            'quota_exceeded',
            'Guest drafts are limited to 20 photos and 250 MB. Sign in to upload more.',
            {
              reason: 'guest_file_limit',
              requiresAuth: true,
            },
          );
        }
        if (this.quota.reservedBytes + body.size > GUEST_LIMITS.maxBytes) {
          throw apiError(
            403,
            'quota_exceeded',
            'Guest drafts are limited to 20 photos and 250 MB. Sign in to upload more.',
            {
              reason: 'guest_byte_limit',
              requiresAuth: true,
            },
          );
        }
        this.quota.reservedFiles += 1;
        this.quota.reservedBytes += body.size;
      }
      const intent: FakeIntent = {
        intentId: uuid(),
        mediaId: uuid(),
        clientId: body.clientId,
        filename: body.filename,
        size: body.size,
        plan: planUpload(body.size),
        status: 'pending',
        mediaStatus: 'reserved',
        parts: new Map(),
      };
      this.intents.set(intent.intentId, intent);
      this.byClient.set(body.clientId, intent);
      return { intent: this.intentDto(intent), created: true };
    },
    signParts: async (intentId, partNumbers) => {
      this.calls.push(`sign:${partNumbers.join(',')}`);
      this.takeFailure('signParts');
      const intent = this.intents.get(intentId);
      if (!intent) throw apiError(404, 'not_found', 'Not found.');
      if (intent.status !== 'pending') {
        throw apiError(409, 'conflict', 'Upload is no longer active.', { reason: intent.status });
      }
      intent.mediaStatus = 'uploading';
      return partNumbers.map((n): SignedPart => ({
        partNumber: n,
        url: `https://r2.fake.test/bucket/${intent.intentId}?partNumber=${n}`,
        method: 'PUT',
        headers: intent.plan.multipart ? {} : { 'content-type': 'image/jpeg' },
        contentLength: partLength(intent.plan, intent.size, n),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }));
    },
    getUpload: async (intentId) => {
      this.calls.push('state');
      this.takeFailure('getUpload');
      const intent = this.intents.get(intentId);
      if (!intent) throw apiError(404, 'not_found', 'Not found.');
      return this.stateDto(intent);
    },
    complete: async (intentId, body) => {
      this.calls.push('complete');
      this.takeFailure('complete');
      const intent = this.intents.get(intentId);
      if (!intent) throw apiError(404, 'not_found', 'Not found.');
      if (intent.status === 'completed') {
        return {
          intentId,
          mediaId: intent.mediaId,
          status: 'completed',
          mediaStatus: intent.mediaStatus,
        };
      }
      for (let n = 1; n <= intent.plan.partCount; n++) {
        const stored = intent.parts.get(n);
        const sent = body.parts.find((p) => p.number === n);
        if (!stored || (intent.plan.multipart && sent?.etag !== stored.etag)) {
          throw apiError(409, 'conflict', 'Part mismatch.', { reason: 'part_mismatch' }, true);
        }
      }
      intent.status = 'completed';
      intent.mediaStatus = 'uploaded';
      return { intentId, mediaId: intent.mediaId, status: 'completed', mediaStatus: 'uploaded' };
    },
    abort: async (intentId) => {
      this.calls.push('abort');
      const intent = this.intents.get(intentId);
      if (!intent || intent.status !== 'pending') return;
      intent.status = 'aborted';
      intent.mediaStatus = 'deleting';
      if (this.guest) {
        this.quota.reservedFiles -= 1;
        this.quota.reservedBytes -= intent.size;
      }
    },
    getGuestDraft: async (): Promise<GuestDraftResponse> => {
      this.calls.push('draft');
      this.takeFailure('getGuestDraft');
      return {
        gallery: {
          id: this.galleryId,
          title: 'Untitled gallery',
          status: 'draft',
          createdAt: new Date().toISOString(),
        },
        draftExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        quota: { ...this.quota, maxFiles: GUEST_LIMITS.maxFiles, maxBytes: GUEST_LIMITS.maxBytes },
        media: [...this.intents.values()]
          .filter((i) => i.status !== 'aborted')
          .map((i) => ({
            id: i.mediaId,
            filename: i.filename,
            mime: 'image/jpeg' as const,
            size: i.size,
            status: i.mediaStatus,
            sortKey: 'a0',
            uploadId: i.intentId,
            uploadStatus: i.status,
          })),
      };
    },
    createGuestDraft: async () => ({
      galleryId: this.galleryId,
      draftExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    createGallery: async () => {
      throw new Error('not used');
    },
  };

  readonly transport: PutTransport = async (request) => {
    const url = new URL(request.url);
    this.putCount += 1;
    this.activePuts += 1;
    this.maxActivePuts = Math.max(this.maxActivePuts, this.activePuts);
    try {
      await this.onPut?.(request, url);
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const forced = this.putFailures.shift();
      if (forced) return { status: 0, etag: null, retryAfterMs: null, ...forced };
      const intent = this.intents.get(url.pathname.split('/').pop()!);
      const n = Number(url.searchParams.get('partNumber'));
      if (!intent) return { status: 404, etag: null, retryAfterMs: null };
      const etag = `"etag-${intent.intentId.slice(-4)}-${n}"`;
      intent.parts.set(n, { etag, size: request.body.size });
      request.onProgress(request.body.size);
      return { status: 200, etag, retryAfterMs: null };
    } finally {
      this.activePuts -= 1;
    }
  };

  setMediaStatus(status: MediaStatus): void {
    for (const intent of this.intents.values())
      if (intent.status === 'completed') intent.mediaStatus = status;
  }

  private intentDto(i: FakeIntent): UploadIntentResponse {
    return {
      intentId: i.intentId,
      mediaId: i.mediaId,
      multipart: i.plan.multipart,
      partSize: i.plan.partSize,
      partCount: i.plan.partCount,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: i.status,
      mediaStatus: i.mediaStatus,
    };
  }

  private stateDto(i: FakeIntent): UploadStateResponse {
    return {
      ...this.intentDto(i),
      galleryId: this.galleryId,
      size: i.size,
      mime: 'image/jpeg',
      parts: [...i.parts.entries()].map(([number, p]) => ({ number, etag: p.etag, size: p.size })),
    };
  }
}

export function apiError(
  status: number,
  code: ConstructorParameters<typeof UploadApiError>[1],
  message: string,
  details: Record<string, unknown> = {},
  retryable = status >= 500 || status === 429,
  retryAfterMs: number | null = null,
): UploadApiError {
  return new UploadApiError(status, code, message, retryable, details, retryAfterMs);
}
