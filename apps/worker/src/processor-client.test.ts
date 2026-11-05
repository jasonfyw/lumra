import { describe, expect, it } from 'vitest';
import {
  createProcessorClient,
  TransientProcessorError,
  type ProcessInput,
} from './processor-client';

const mediaId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const input = (): ProcessInput => ({
  mediaId,
  expectedMime: 'image/heic',
  widths: [320, 640],
  traceId: 'req-1',
  body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
  byteSize: 3,
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    mediaId,
    source: { mime: 'image/heic', width: 400, height: 300, orientation: null, takenAt: null },
    encoding: { format: 'webp', quality: 80, pipelineVersion: 1 },
    variants: [
      { variant: 'w320', field: 'w320', mime: 'image/webp', width: 320, height: 240, byteSize: 4 },
    ],
    ...overrides,
  };
}

function multipart(
  m: unknown,
  parts: Record<string, Uint8Array> = { w320: new Uint8Array([1, 2, 3, 4]) },
) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(m));
  for (const [name, bytes] of Object.entries(parts)) {
    form.append(name, new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), `${name}.webp`);
  }
  return new Response(form);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createProcessorClient', () => {
  it('sends the contract headers and parses manifest-first multipart', async () => {
    let seen: Request | undefined;
    const client = createProcessorClient(async (req) => {
      seen = req;
      return multipart(manifest());
    });
    const result = await client.process(input());
    expect(seen!.method).toBe('POST');
    expect(new URL(seen!.url).pathname).toBe('/process');
    expect(seen!.headers.get('x-lumra-media-id')).toBe(mediaId);
    expect(seen!.headers.get('x-lumra-expected-mime')).toBe('image/heic');
    expect(seen!.headers.get('x-lumra-widths')).toBe('320,640');
    expect(seen!.headers.get('x-request-id')).toBe('req-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.files[0]!.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('maps 422 rejections to a permanent failure code', async () => {
    const client = createProcessorClient(async () =>
      json(422, { error: { code: 'heic_unsupported_variant', retryable: false, message: 'x' } }),
    );
    expect(await client.process(input())).toEqual({ ok: false, code: 'heic_unsupported_variant' });
  });

  it.each([
    [
      'busy 503',
      async () => json(503, { error: { code: 'processor_busy', retryable: true, message: '' } }),
    ],
    [
      'bad_request (our bug)',
      async () => json(400, { error: { code: 'bad_request', retryable: false, message: '' } }),
    ],
    ['opaque 502', async () => new Response('bad gateway', { status: 502 })],
    ['network error', async () => Promise.reject(new TypeError('fetch failed'))],
    [
      'manifest for another media',
      async () => multipart(manifest({ mediaId: '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f' })),
    ],
    ['missing part', async () => multipart(manifest(), {})],
    ['size mismatch', async () => multipart(manifest(), { w320: new Uint8Array([1]) })],
    [
      'pipeline version skew',
      async () =>
        multipart(manifest({ encoding: { format: 'webp', quality: 80, pipelineVersion: 2 } })),
    ],
  ])('treats %s as transient', async (_name, fetcher) => {
    const client = createProcessorClient(fetcher as (r: Request) => Promise<Response>);
    await expect(client.process(input())).rejects.toBeInstanceOf(TransientProcessorError);
  });
});
