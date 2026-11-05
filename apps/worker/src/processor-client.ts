import { DERIVATIVE_ENCODING, PROCESSOR_LIMITS, type AcceptedPhotoMime } from '@lumra/config';
import {
  PROCESSOR_HEADERS,
  PROCESSOR_PATH,
  PROCESSOR_TRANSIENT_CODES,
  processManifestSchema,
  processorErrorBodySchema,
  type MediaRejectionCode,
  type ProcessManifest,
  type ProcessedVariant,
} from '@lumra/contracts';
import { MEDIA_REJECTION_CODES } from '@lumra/contracts';

export interface ProcessInput {
  mediaId: string;
  expectedMime: AcceptedPhotoMime;
  widths: readonly number[];
  traceId: string;
  /** Original bytes, streamed straight from R2; never buffered in the Worker. */
  body: ReadableStream<Uint8Array>;
  byteSize: number;
}

export interface ProcessedFile extends ProcessedVariant {
  bytes: Uint8Array;
}

export type ProcessResult =
  | { ok: true; manifest: ProcessManifest; files: ProcessedFile[] }
  | { ok: false; code: MediaRejectionCode };

/** The processor container, behind an interface so the queue handler is testable with fakes. */
export interface ProcessorClient {
  /** Resolves with derivatives or a permanent rejection; throws on transient failures. */
  process(input: ProcessInput): Promise<ProcessResult>;
}

/** Retryable processor failure (5xx, network, timeout, protocol error). */
export class TransientProcessorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientProcessorError';
  }
}

export type Fetcher = (request: Request) => Promise<Response>;

const REJECTION_CODES: ReadonlySet<string> = new Set(MEDIA_REJECTION_CODES);
const TRANSIENT_CODES: ReadonlySet<string> = new Set(PROCESSOR_TRANSIENT_CODES);

async function parseSuccess(response: Response, mediaId: string): Promise<ProcessResult> {
  let form: FormData;
  try {
    form = await response.formData();
  } catch {
    throw new TransientProcessorError('processor returned an unreadable multipart body');
  }
  const rawManifest = form.get('manifest');
  if (typeof rawManifest !== 'string') {
    throw new TransientProcessorError('processor response has no manifest');
  }
  const parsed = processManifestSchema.safeParse(JSON.parse(rawManifest));
  if (!parsed.success || parsed.data.mediaId !== mediaId) {
    throw new TransientProcessorError('processor manifest is invalid');
  }
  if (parsed.data.encoding.pipelineVersion !== DERIVATIVE_ENCODING.pipelineVersion) {
    // Mixed deploys (old container, new worker): retry until both sides agree.
    throw new TransientProcessorError('processor pipeline version mismatch');
  }
  const files: ProcessedFile[] = [];
  for (const variant of parsed.data.variants) {
    const part = form.get(variant.field);
    if (!part || typeof part === 'string') {
      throw new TransientProcessorError(`processor response is missing ${variant.field}`);
    }
    const bytes = new Uint8Array(await part.arrayBuffer());
    if (bytes.byteLength !== variant.byteSize) {
      throw new TransientProcessorError(`processor part ${variant.field} has the wrong size`);
    }
    files.push({ ...variant, bytes });
  }
  return { ok: true, manifest: parsed.data, files };
}

/**
 * Speaks the `@lumra/contracts` processor protocol over any fetch-like transport: the
 * Cloudflare Containers Durable Object stub in deployed envs, or plain `fetch` to
 * `PROCESSOR_URL` locally.
 */
export function createProcessorClient(
  fetcher: Fetcher,
  options: { timeoutMs?: number } = {},
): ProcessorClient {
  const timeoutMs = options.timeoutMs ?? PROCESSOR_LIMITS.clientTimeoutMs;
  return {
    async process(input) {
      const request = new Request(`http://image-processor${PROCESSOR_PATH}`, {
        method: 'POST',
        body: input.body,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(input.byteSize),
          [PROCESSOR_HEADERS.mediaId]: input.mediaId,
          [PROCESSOR_HEADERS.expectedMime]: input.expectedMime,
          [PROCESSOR_HEADERS.widths]: input.widths.join(','),
          [PROCESSOR_HEADERS.traceId]: input.traceId,
        },
        signal: AbortSignal.timeout(timeoutMs),
        // Streaming request bodies need `duplex: 'half'` in Node/undici; workerd ignores it.
        ...({ duplex: 'half' } as Record<string, unknown>),
      });

      let response: Response;
      try {
        response = await fetcher(request);
      } catch (error) {
        throw new TransientProcessorError(
          `processor unreachable: ${error instanceof Error ? error.name : 'error'}`,
        );
      }

      if (response.ok) return parseSuccess(response, input.mediaId);

      const body = processorErrorBodySchema.safeParse(await response.json().catch(() => null));
      if (body.success) {
        const { code, retryable } = body.data.error;
        if (!retryable && REJECTION_CODES.has(code)) {
          return { ok: false, code: code as MediaRejectionCode };
        }
        if (retryable || TRANSIENT_CODES.has(code)) {
          throw new TransientProcessorError(`processor ${response.status} ${code}`);
        }
        // `bad_request` means the worker sent something the contract forbids: a bug, not the
        // user's photo. Retry → DLQ so it is investigated instead of failing the media.
        throw new TransientProcessorError(`processor rejected the request: ${code}`);
      }
      throw new TransientProcessorError(`processor ${response.status}`);
    },
  };
}
