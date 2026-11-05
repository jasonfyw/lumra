/**
 * In-memory fake of the R2 S3 API at the `fetch` level, for upload integration tests. It serves
 * the server-side calls (CreateMultipartUpload, ListParts, CompleteMultipartUpload,
 * AbortMultipartUpload, HeadObject) and lets tests act as the browser by PUTting to presigned
 * URLs. Presigned PUTs are verified like R2 would: SigV4 query signature (independent node:crypto
 * implementation), expiry, signed `content-length` (and `content-type`) — so the tests prove the
 * URLs are bound to one key, part number and length.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const R2_ENDPOINT = 'https://r2.fake.test';
export const R2_BUCKET = 'lumra-originals-test';
export const R2_ACCESS_KEY_ID = 'AKIDFAKETEST';
export const R2_SECRET_ACCESS_KEY = 'fake-secret-access-key-for-tests-only';

interface MultipartUpload {
  key: string;
  contentType: string;
  parts: Map<number, { etag: string; size: number }>;
}

export interface FakeR2Call {
  method: string;
  operation: string;
  key: string;
}

function enc(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sigV4QuerySignature(url: URL, method: string, headers: Record<string, string>): string {
  const params = [...url.searchParams]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
  const all: Record<string, string> = { ...headers, host: url.host };
  const canonical = [
    method,
    url.pathname,
    params,
    signed.map((n) => `${n}:${all[n] ?? ''}`).join('\n') + '\n',
    signed.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const amzDate = url.searchParams.get('X-Amz-Date')!;
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
  let key = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, amzDate.slice(0, 8));
  for (const part of ['auto', 's3', 'aws4_request']) key = hmac(key, part);
  return createHmac('sha256', key).update(toSign).digest('hex');
}

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { 'content-type': 'application/xml' },
  });

const s3Error = (code: string, status: number) =>
  xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);

export class FakeR2 {
  readonly objects = new Map<string, { size: number; contentType: string }>();
  readonly uploads = new Map<string, MultipartUpload>();
  readonly calls: FakeR2Call[] = [];
  /** Non-R2 requests (e.g. Turnstile) are delegated here. */
  passthrough: ((request: Request) => Promise<Response>) | null = null;

  reset(): void {
    this.objects.clear();
    this.uploads.clear();
    this.calls.length = 0;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== R2_ENDPOINT) {
      if (this.passthrough) return this.passthrough(request);
      throw new Error(`unexpected fetch to ${url.origin}`);
    }
    const prefix = `/${R2_BUCKET}/`;
    if (!url.pathname.startsWith(prefix)) return s3Error('NoSuchBucket', 404);
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const q = url.searchParams;

    if (request.method === 'POST' && q.has('uploads')) {
      this.calls.push({ method: 'POST', operation: 'CreateMultipartUpload', key });
      const uploadId = `up-${randomUUID()}`;
      this.uploads.set(uploadId, {
        key,
        contentType: request.headers.get('content-type') ?? '',
        parts: new Map(),
      });
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${R2_BUCKET}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (request.method === 'GET' && q.has('uploadId')) {
      this.calls.push({ method: 'GET', operation: 'ListParts', key });
      const upload = this.uploads.get(q.get('uploadId')!);
      if (!upload || upload.key !== key) return s3Error('NoSuchUpload', 404);
      const parts = [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(
          ([n, p]) =>
            `<Part><PartNumber>${n}</PartNumber><ETag>"${p.etag}"</ETag><Size>${p.size}</Size></Part>`,
        )
        .join('');
      return xml(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
    }

    if (request.method === 'POST' && q.has('uploadId')) {
      this.calls.push({ method: 'POST', operation: 'CompleteMultipartUpload', key });
      const upload = this.uploads.get(q.get('uploadId')!);
      if (!upload || upload.key !== key) return s3Error('NoSuchUpload', 404);
      const body = await request.text();
      let size = 0;
      for (const m of body.matchAll(
        /<Part><PartNumber>(\d+)<\/PartNumber><ETag>"([^"]+)"<\/ETag><\/Part>/g,
      )) {
        const part = upload.parts.get(Number(m[1]));
        if (!part || part.etag !== m[2]) return s3Error('InvalidPart', 400);
        size += part.size;
      }
      this.objects.set(key, { size, contentType: upload.contentType });
      this.uploads.delete(q.get('uploadId')!);
      return xml(
        `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"multi-${randomUUID().slice(0, 8)}-${upload.parts.size}"</ETag></CompleteMultipartUploadResult>`,
      );
    }

    if (request.method === 'DELETE' && q.has('uploadId')) {
      this.calls.push({ method: 'DELETE', operation: 'AbortMultipartUpload', key });
      if (!this.uploads.delete(q.get('uploadId')!)) return s3Error('NoSuchUpload', 404);
      return new Response(null, { status: 204 });
    }

    if (request.method === 'HEAD') {
      this.calls.push({ method: 'HEAD', operation: 'HeadObject', key });
      const obj = this.objects.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(obj.size),
          'content-type': obj.contentType,
          etag: '"obj"',
        },
      });
    }

    return s3Error('NotImplemented', 501);
  };

  /**
   * Acts as the browser: PUT `size` bytes to a presigned URL with the returned headers. Returns
   * the HTTP status and the ETag (as R2 would expose via CORS). Validates the presigned request.
   */
  browserPut(
    signed: { url: string; headers: Record<string, string> },
    size: number,
    now = new Date(),
  ): { status: number; etag: string | null; error?: string } {
    const url = new URL(signed.url);
    const prefix = `/${R2_BUCKET}/`;
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const q = url.searchParams;
    const headers: Record<string, string> = { ...signed.headers, 'content-length': String(size) };

    const fail = (error: string) => ({ status: 403, etag: null, error });
    if (q.get('X-Amz-Credential')?.split('/')[0] !== R2_ACCESS_KEY_ID) return fail('credential');
    if (sigV4QuerySignature(url, 'PUT', headers) !== q.get('X-Amz-Signature')) {
      return fail('SignatureDoesNotMatch');
    }
    const date = q.get('X-Amz-Date')!;
    const signedAt = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    if (now.getTime() > signedAt + Number(q.get('X-Amz-Expires')) * 1000) return fail('expired');

    if (q.has('uploadId')) {
      const upload = this.uploads.get(q.get('uploadId')!);
      if (!upload || upload.key !== key) return { status: 404, etag: null, error: 'NoSuchUpload' };
      const etag = createHash('md5')
        .update(`${key}:${q.get('partNumber')}:${size}`)
        .digest('hex');
      upload.parts.set(Number(q.get('partNumber')), { etag, size });
      return { status: 200, etag: `"${etag}"` };
    }
    this.objects.set(key, { size, contentType: headers['content-type'] ?? '' });
    return { status: 200, etag: '"single"' };
  }
}
