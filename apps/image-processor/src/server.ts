import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { DERIVATIVE_WIDTHS, PROCESSOR_LIMITS } from '@lumra/config';
import {
  PROCESSOR_HEADERS,
  PROCESSOR_PATH,
  processRequestParamsSchema,
  type ProcessorErrorBody,
  type ProcessorErrorCode,
  type ProcessRequestParams,
} from '@lumra/contracts';
import { ProcessingError, processImage, type ProcessOptions } from './process';

export interface ServerOptions extends ProcessOptions {
  maxInputBytes?: number;
  maxConcurrentJobs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string, fields = {}) {
  const sink = { info: console.info, warn: console.warn, error: console.error }[level];
  sink(JSON.stringify({ level, msg, service: 'image-processor', ...fields }));
}

function statusFor(error: ProcessingError): number {
  if (error.code === 'file_too_large') return 413;
  if (error.code === 'bad_request') return 400;
  if (error.code === 'processor_busy' || error.code === 'processor_unavailable') return 503;
  if (error.retryable) return 500;
  return 422;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function parseParams(req: IncomingMessage): ProcessRequestParams {
  const widthsRaw = header(req, PROCESSOR_HEADERS.widths);
  const parsed = processRequestParamsSchema.safeParse({
    mediaId: header(req, PROCESSOR_HEADERS.mediaId),
    expectedMime: header(req, PROCESSOR_HEADERS.expectedMime),
    widths: widthsRaw ? widthsRaw.split(',').map((w) => Number(w.trim())) : [...DERIVATIVE_WIDTHS],
    traceId: header(req, PROCESSOR_HEADERS.traceId) ?? 'unknown',
  });
  if (!parsed.success) throw new ProcessingError('bad_request', false, 'invalid parameters');
  return parsed.data;
}

/** Reads the request body, aborting as soon as it exceeds `maxBytes`. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(header(req, 'content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProcessingError('file_too_large', false, 'input exceeds size limit');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw new ProcessingError('file_too_large', false, 'input exceeds size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * HTTP surface of the processor container (contract: `@lumra/contracts` processor.ts).
 * `GET /healthz` reports HEIF support; `POST /process` returns manifest-first multipart.
 */
export function createServer(options: ServerOptions = {}): Server {
  const log = options.log ?? defaultLog;
  const maxInputBytes = options.maxInputBytes ?? PROCESSOR_LIMITS.maxInputBytes;
  const maxJobs = options.maxConcurrentJobs ?? PROCESSOR_LIMITS.maxConcurrentJobs;
  let active = 0;

  return createHttpServer(async (req, res) => {
    const sendError = (
      code: ProcessorErrorCode,
      retryable: boolean,
      message: string,
      status: number,
    ) => {
      const body: ProcessorErrorBody = { error: { code, retryable, message } };
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 503 ? { 'retry-after': '5' } : {}),
      });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? '/', 'http://processor.internal');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active }));
      return;
    }
    if (url.pathname !== PROCESSOR_PATH) {
      sendError('bad_request', false, 'not found', 404);
      return;
    }
    if (req.method !== 'POST') {
      sendError('bad_request', false, 'method not allowed', 405);
      return;
    }
    if (active >= maxJobs) {
      req.resume();
      sendError('processor_busy', true, 'processor busy', 503);
      return;
    }

    active++;
    const started = Date.now();
    let params: ProcessRequestParams | undefined;
    try {
      params = parseParams(req);
      const input = await readBody(req, maxInputBytes);
      const { manifest, files } = await processImage(input, params, options);

      const form = new FormData();
      form.append('manifest', JSON.stringify(manifest));
      for (const variant of manifest.variants) {
        const bytes = files.get(variant.field);
        if (!bytes) throw new ProcessingError('internal_error', true, 'missing variant bytes');
        form.append(
          variant.field,
          new Blob([new Uint8Array(bytes)], { type: variant.mime }),
          `${variant.field}.webp`,
        );
      }
      const encoded = new Response(form);
      res.writeHead(200, {
        'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
        'cache-control': 'no-store',
      });
      Readable.fromWeb(encoded.body as NodeReadableStream).pipe(res);
      log('info', 'processed', {
        mediaId: params.mediaId,
        traceId: params.traceId,
        variants: manifest.variants.length,
        inputBytes: input.length,
        ms: Date.now() - started,
      });
    } catch (error) {
      const failure =
        error instanceof ProcessingError
          ? error
          : new ProcessingError('internal_error', true, 'internal processing error');
      log(failure.retryable ? 'error' : 'warn', 'process failed', {
        mediaId: params?.mediaId,
        traceId: params?.traceId,
        code: failure.code,
        ms: Date.now() - started,
        ...(failure.code === 'internal_error' && error instanceof Error
          ? { error: error.message.slice(0, 200) }
          : {}),
      });
      if (!req.complete) req.resume();
      sendError(failure.code, failure.retryable, failure.message, statusFor(failure));
    } finally {
      active--;
    }
  });
}
