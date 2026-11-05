import { AwsClient } from 'aws4fetch';
import { UPLOAD_LIMITS } from '@lumra/config';
import { assertStorageKey } from './keys';

/**
 * Cloudflare R2 adapter over the S3-compatible API (PRD §6.2, §18).
 *
 * Uses `aws4fetch` (Web Crypto + fetch) so the same code runs on Vercel (Node) and in Workers.
 * Presigned URLs only work on the account's S3 endpoint (`<account>.r2.cloudflarestorage.com`),
 * never on custom domains, and are bearer credentials until they expire — keep TTLs short and
 * never log them. Objects are addressed only by keys from the key builders in `./keys`.
 */

export interface R2ClientConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override the S3 endpoint (e.g. a jurisdiction endpoint or a local fake). No trailing slash. */
  endpoint?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected clock for tests. */
  now?: () => Date;
}

export interface PresignedRequest {
  url: string;
  method: 'PUT';
  /**
   * Headers the browser must send unchanged. `content-length` is signed too, but browsers set it
   * from the body automatically (it is a forbidden header for scripts), so it is not listed here.
   */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignPutOptions {
  contentType: string;
  contentLength: number;
  expiresIn?: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  size: number;
  etag: string;
  contentType: string | null;
}

export class R2Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly operation: string,
  ) {
    // Never include the request URL: presigned/query-signed URLs are credentials.
    super(`R2 ${operation} failed: ${status} ${code}`);
    this.name = 'R2Error';
  }
}

const MAX_PART_NUMBER = UPLOAD_LIMITS.maxPartCount;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT = /^[A-Za-z0-9-]+$/;

/** Clamp a requested presign lifetime to [1, UPLOAD_LIMITS.presignTtlSeconds]. */
export function clampPresignTtl(expiresIn?: number): number {
  const max = UPLOAD_LIMITS.presignTtlSeconds;
  if (expiresIn === undefined || !Number.isFinite(expiresIn)) return max;
  return Math.min(max, Math.max(1, Math.floor(expiresIn)));
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
    throw new RangeError(`partNumber must be an integer in 1..${MAX_PART_NUMBER}`);
  }
}

function assertUploadId(uploadId: string): void {
  if (!uploadId || uploadId.length > 1024 || /[\s<>&]/.test(uploadId)) {
    throw new Error('Invalid uploadId');
  }
}

function assertContentType(contentType: string): void {
  if (!MIME.test(contentType)) throw new Error('Invalid contentType');
}

function assertContentLength(contentLength: number, max: number): void {
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > max) {
    throw new RangeError(`contentLength must be an integer in 1..${max}`);
  }
}

// --- Minimal XML helpers (Workers have no DOMParser). S3 responses are flat and predictable. ---

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function xmlDecode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] === undefined ? null : xmlDecode(match[1]);
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1] ?? '');
}

/** Builds the CompleteMultipartUpload request body; parts are sorted ascending and deduplicated. */
export function completeMultipartXml(parts: readonly CompletedPart[]): string {
  if (parts.length === 0) throw new Error('At least one part is required');
  if (parts.length > MAX_PART_NUMBER) throw new RangeError('Too many parts');
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  let previous = 0;
  const body = sorted
    .map(({ partNumber, etag }) => {
      assertPartNumber(partNumber);
      if (partNumber === previous) throw new Error(`Duplicate partNumber ${partNumber}`);
      previous = partNumber;
      const bare = etag.replace(/^"|"$/g, '');
      if (!/^[A-Za-z0-9-]{1,128}$/.test(bare)) throw new Error('Invalid part ETag');
      return `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${xmlEscape(bare)}"</ETag></Part>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</CompleteMultipartUpload>`;
}

export interface R2Client {
  readonly bucket: string;
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest>;
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
    contentLength?: number,
  ): Promise<PresignedRequest>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<{ etag: string | null }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  headObject(key: string): Promise<ObjectHead | null>;
}

export function createR2Client(config: R2ClientConfig): R2Client {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config;
  if (!ACCOUNT.test(accountId)) throw new Error('Invalid R2 accountId');
  if (!BUCKET.test(bucket)) throw new Error('Invalid R2 bucket name');
  if (!accessKeyId || !secretAccessKey) throw new Error('R2 credentials are required');

  const endpoint = config.endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`;
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => new Date());
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });

  function objectUrl(key: string, query: Record<string, string> = {}): URL {
    assertStorageKey(key);
    const url = new URL(`${endpoint}/${bucket}/${key}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async function presign(
    url: URL,
    headers: Record<string, string>,
    expiresIn: number | undefined,
  ): Promise<PresignedRequest> {
    const ttl = clampPresignTtl(expiresIn);
    const signedAt = now();
    url.searchParams.set('X-Amz-Expires', String(ttl));
    const signed = await aws.sign(url.toString(), {
      method: 'PUT',
      headers,
      // allHeaders: sign content-type/content-length too so the browser cannot change them.
      aws: { signQuery: true, allHeaders: true, datetime: amzDate(signedAt) },
    });
    const clientHeaders = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'content-length'),
    );
    return {
      url: signed.url,
      method: 'PUT',
      headers: clientHeaders,
      expiresAt: new Date(signedAt.getTime() + ttl * 1000),
    };
  }

  async function send(
    operation: string,
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    const request = await aws.sign(url.toString(), {
      method,
      headers: init.headers ?? {},
      body: init.body ?? null,
      aws: { datetime: amzDate(now()) },
    });
    const response = await doFetch(request);
    if (!response.ok && response.status !== 404) {
      const text = method === 'HEAD' ? '' : await response.text();
      throw new R2Error(response.status, xmlText(text, 'Code') ?? 'UnknownError', operation);
    }
    return response;
  }

  async function notFound(operation: string, response: Response): Promise<never> {
    const text = await response.text();
    throw new R2Error(404, xmlText(text, 'Code') ?? 'NotFound', operation);
  }

  return {
    bucket,

    async presignPut(key, { contentType, contentLength, expiresIn }) {
      assertContentType(contentType);
      assertContentLength(contentLength, UPLOAD_LIMITS.multipartThresholdBytes);
      return presign(
        objectUrl(key),
        { 'content-type': contentType, 'content-length': String(contentLength) },
        expiresIn,
      );
    },

    async createMultipartUpload(key, contentType) {
      assertContentType(contentType);
      const url = objectUrl(key);
      url.search = 'uploads';
      const response = await send('CreateMultipartUpload', 'POST', url, {
        headers: { 'content-type': contentType },
      });
      if (response.status === 404) return notFound('CreateMultipartUpload', response);
      const uploadId = xmlText(await response.text(), 'UploadId');
      if (!uploadId) throw new R2Error(response.status, 'MissingUploadId', 'CreateMultipartUpload');
      return { uploadId };
    },

    async presignUploadPart(key, uploadId, partNumber, expiresIn, contentLength) {
      assertUploadId(uploadId);
      assertPartNumber(partNumber);
      const headers: Record<string, string> = {};
      if (contentLength !== undefined) {
        assertContentLength(contentLength, UPLOAD_LIMITS.maxPhotoBytes);
        headers['content-length'] = String(contentLength);
      }
      const url = objectUrl(key, { partNumber: String(partNumber), uploadId });
      return presign(url, headers, expiresIn);
    },

    async listParts(key, uploadId) {
      assertUploadId(uploadId);
      const parts: UploadedPart[] = [];
      let marker: string | null = null;
      for (let page = 0; page < 20; page++) {
        const query: Record<string, string> = { uploadId };
        if (marker) query['part-number-marker'] = marker;
        const response = await send('ListParts', 'GET', objectUrl(key, query));
        if (response.status === 404) return notFound('ListParts', response);
        const xml = await response.text();
        for (const block of xmlBlocks(xml, 'Part')) {
          parts.push({
            partNumber: Number(xmlText(block, 'PartNumber')),
            etag: xmlText(block, 'ETag') ?? '',
            size: Number(xmlText(block, 'Size')),
          });
        }
        if (xmlText(xml, 'IsTruncated') !== 'true') return parts;
        marker = xmlText(xml, 'NextPartNumberMarker');
        if (!marker) return parts;
      }
      throw new R2Error(500, 'TooManyPartPages', 'ListParts');
    },

    async completeMultipartUpload(key, uploadId, parts) {
      assertUploadId(uploadId);
      const body = completeMultipartXml(parts);
      const response = await send('CompleteMultipartUpload', 'POST', objectUrl(key, { uploadId }), {
        headers: { 'content-type': 'application/xml' },
        body,
      });
      if (response.status === 404) return notFound('CompleteMultipartUpload', response);
      // S3 may answer 200 with an <Error> body when completion fails late.
      const xml = await response.text();
      if (/<Error>/.test(xml)) {
        throw new R2Error(
          response.status,
          xmlText(xml, 'Code') ?? 'UnknownError',
          'CompleteMultipartUpload',
        );
      }
      return { etag: xmlText(xml, 'ETag') };
    },

    async abortMultipartUpload(key, uploadId) {
      assertUploadId(uploadId);
      // Idempotent: an already-aborted or completed upload (404 NoSuchUpload) is not an error.
      await send('AbortMultipartUpload', 'DELETE', objectUrl(key, { uploadId }));
    },

    async headObject(key) {
      const response = await send('HeadObject', 'HEAD', objectUrl(key));
      if (response.status === 404) return null;
      const size = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new R2Error(response.status, 'MissingContentLength', 'HeadObject');
      }
      return {
        size,
        etag: response.headers.get('etag') ?? '',
        contentType: response.headers.get('content-type'),
      };
    },
  };
}
