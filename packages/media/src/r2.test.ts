import { createHash, createHmac } from 'node:crypto';
import { UPLOAD_LIMITS } from '@lumra/config';
import { describe, expect, it, vi } from 'vitest';
import { originalKey } from './keys';
import { clampPresignTtl, completeMultipartXml, createR2Client, R2Error } from './r2';

const accountId = '0123456789abcdef0123456789abcdef';
const accessKeyId = 'AKIDEXAMPLE';
const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const bucket = 'lumra-originals-dev';
const fixedNow = new Date('2026-11-05T12:00:00.000Z');
const key = originalKey(
  'owner-123456',
  '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
  '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);

type Handler = (request: Request) => Response | Promise<Response>;

function client(handler: Handler = () => new Response(null, { status: 200 })) {
  const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(input, init)),
  );
  const r2 = createR2Client({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => fixedNow,
  });
  return { r2, fetchMock };
}

/** Independent SigV4 query-signature reference (node:crypto) to cross-check aws4fetch output. */
function referenceSignature(url: URL, method: string, headers: Record<string, string>): string {
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const params = [...url.searchParams]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const all: Record<string, string> = { host: url.host, ...headers };
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    url.pathname,
    params,
    names.map((n) => `${n}:${all[n]}`).join('\n') + '\n',
    names.join(';'),
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
  let signingKey = hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8));
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  return createHmac('sha256', signingKey).update(toSign).digest('hex');
}

describe('clampPresignTtl', () => {
  it('clamps to [1, presignTtlSeconds]', () => {
    expect(clampPresignTtl()).toBe(UPLOAD_LIMITS.presignTtlSeconds);
    expect(clampPresignTtl(86_400)).toBe(UPLOAD_LIMITS.presignTtlSeconds);
    expect(clampPresignTtl(600)).toBe(600);
    expect(clampPresignTtl(0)).toBe(1);
    expect(clampPresignTtl(Number.POSITIVE_INFINITY)).toBe(UPLOAD_LIMITS.presignTtlSeconds);
  });
});

describe('createR2Client', () => {
  it('validates configuration', () => {
    const base = { accountId, accessKeyId, secretAccessKey, bucket };
    expect(() => createR2Client({ ...base, accountId: 'evil.com/x' })).toThrow();
    expect(() => createR2Client({ ...base, bucket: 'Bad_Bucket' })).toThrow();
    expect(() => createR2Client({ ...base, secretAccessKey: '' })).toThrow();
  });
});

describe('presignPut', () => {
  it('produces a short-lived URL on the S3 endpoint that signs content-type and content-length', async () => {
    const { r2, fetchMock } = client();
    const signed = await r2.presignPut(key, {
      contentType: 'image/jpeg',
      contentLength: 1_234_567,
      expiresIn: 3600,
    });
    const url = new URL(signed.url);
    expect(url.origin).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${bucket}/${key}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${accessKeyId}/20261105/auto/s3/aws4_request`,
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261105T120000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_LIMITS.presignTtlSeconds));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      referenceSignature(url, 'PUT', {
        'content-length': '1234567',
        'content-type': 'image/jpeg',
      }),
    );
    expect(signed.method).toBe('PUT');
    expect(signed.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(signed.expiresAt.toISOString()).toBe('2026-11-05T12:15:00.000Z');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses non-builder keys, bad types and sizes above the single-PUT threshold', async () => {
    const { r2 } = client();
    const opts = { contentType: 'image/png', contentLength: 10 };
    await expect(r2.presignPut('originals/../../secret', opts)).rejects.toThrow();
    await expect(r2.presignPut('IMG_0001.jpg', opts)).rejects.toThrow();
    await expect(
      r2.presignPut(key, { ...opts, contentType: 'image/png\r\nx: y' }),
    ).rejects.toThrow();
    await expect(r2.presignPut(key, { ...opts, contentLength: 0 })).rejects.toThrow(RangeError);
    await expect(
      r2.presignPut(key, {
        ...opts,
        contentLength: UPLOAD_LIMITS.multipartThresholdBytes + 1,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('multipart', () => {
  it('creates an upload with the bound content type', async () => {
    const { r2, fetchMock } = client(
      () =>
        new Response(
          '<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>abc&amp;123</UploadId></InitiateMultipartUploadResult>',
        ),
    );
    await expect(r2.createMultipartUpload(key, 'image/heic')).resolves.toEqual({
      uploadId: 'abc&123',
    });
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}?uploads`,
    );
    expect(request.headers.get('content-type')).toBe('image/heic');
    expect(request.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//,
    );
  });

  it('presigns a part bound to uploadId, part number and optional length', async () => {
    const { r2 } = client();
    const signed = await r2.presignUploadPart(key, 'upload-1', 3, 300, 8 * 1024 * 1024);
    const url = new URL(signed.url);
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      referenceSignature(url, 'PUT', { 'content-length': String(8 * 1024 * 1024) }),
    );
    expect(signed.expiresAt.getTime() - fixedNow.getTime()).toBe(300_000);

    await expect(r2.presignUploadPart(key, 'upload-1', 0)).rejects.toThrow(RangeError);
    await expect(r2.presignUploadPart(key, 'upload-1', 10_001)).rejects.toThrow(RangeError);
    await expect(r2.presignUploadPart(key, '', 1)).rejects.toThrow();
  });

  it('lists parts across pages', async () => {
    const pages = [
      '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>8388608</Size></Part></ListPartsResult>',
      '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>"e2"</ETag><Size>100</Size></Part></ListPartsResult>',
    ];
    const { r2, fetchMock } = client(() => new Response(pages.shift()));
    await expect(r2.listParts(key, 'u1')).resolves.toEqual([
      { partNumber: 1, etag: '"e1"', size: 8_388_608 },
      { partNumber: 2, etag: '"e2"', size: 100 },
    ]);
    const second = new URL((fetchMock.mock.calls[1]![0] as Request).url);
    expect(second.searchParams.get('part-number-marker')).toBe('1');
    expect(second.searchParams.get('uploadId')).toBe('u1');
  });

  it('sends a correct CompleteMultipartUpload body', async () => {
    let body = '';
    const { r2, fetchMock } = client(async (request) => {
      body = await request.text();
      return new Response(
        '<CompleteMultipartUploadResult><ETag>"final-2"</ETag></CompleteMultipartUploadResult>',
      );
    });
    const result = await r2.completeMultipartUpload(key, 'u1', [
      { partNumber: 2, etag: 'bbb' },
      { partNumber: 1, etag: '"aaa"' },
    ]);
    expect(result).toEqual({ etag: '"final-2"' });
    expect(body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part>' +
        '</CompleteMultipartUpload>',
    );
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).searchParams.get('uploadId')).toBe('u1');
  });

  it('treats a 200 response with an <Error> body as a failure', async () => {
    const { r2 } = client(
      () => new Response('<Error><Code>InvalidPart</Code><Message>x</Message></Error>'),
    );
    await expect(
      r2.completeMultipartUpload(key, 'u1', [{ partNumber: 1, etag: 'a' }]),
    ).rejects.toMatchObject({ code: 'InvalidPart', status: 200 });
  });

  it('validates parts before sending', () => {
    expect(() => completeMultipartXml([])).toThrow();
    expect(() =>
      completeMultipartXml([
        { partNumber: 1, etag: 'a' },
        { partNumber: 1, etag: 'b' },
      ]),
    ).toThrow(/Duplicate/);
    expect(() => completeMultipartXml([{ partNumber: 1, etag: '"a"</ETag><x>' }])).toThrow();
  });

  it('aborts idempotently', async () => {
    const statuses = [204, 404];
    const { r2, fetchMock } = client(() => new Response(null, { status: statuses.shift() ?? 500 }));
    await expect(r2.abortMultipartUpload(key, 'u1')).resolves.toBeUndefined();
    await expect(r2.abortMultipartUpload(key, 'u1')).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]![0] as Request).method).toBe('DELETE');
  });
});

describe('headObject', () => {
  it('returns size and etag, or null when missing', async () => {
    const responses = [
      new Response(null, {
        status: 200,
        headers: { 'content-length': '42', etag: '"abc"', 'content-type': 'image/png' },
      }),
      new Response(null, { status: 404 }),
    ];
    const { r2, fetchMock } = client(() => responses.shift()!);
    await expect(r2.headObject(key)).resolves.toEqual({
      size: 42,
      etag: '"abc"',
      contentType: 'image/png',
    });
    await expect(r2.headObject(key)).resolves.toBeNull();
    expect((fetchMock.mock.calls[0]![0] as Request).method).toBe('HEAD');
  });

  it('surfaces S3 error codes without leaking URLs', async () => {
    const { r2 } = client(
      () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    );
    const error = await r2.listParts(key, 'u1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).code).toBe('AccessDenied');
    expect((error as R2Error).message).not.toContain('r2.cloudflarestorage.com');
  });
});
