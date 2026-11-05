import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROCESSOR_HEADERS,
  processManifestSchema,
  processorErrorBodySchema,
} from '@lumra/contracts';
import { createServer } from '../src/server';
import { MEDIA_ID, jpegWithOrientation, pngBomb } from './fixtures';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer({ log: () => {}, maxInputBytes: 5_000_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function post(body: Uint8Array | string, headers: Record<string, string> = {}) {
  return fetch(`${base}/process`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/octet-stream',
      [PROCESSOR_HEADERS.mediaId]: MEDIA_ID,
      [PROCESSOR_HEADERS.expectedMime]: 'image/jpeg',
      [PROCESSOR_HEADERS.traceId]: 'req-test',
      ...headers,
    },
  });
}

describe('image-processor HTTP server', () => {
  it('returns a manifest-first multipart response with one WebP part per variant', async () => {
    const input = await jpegWithOrientation(1500, 1000, 6);
    const res = await post(new Uint8Array(input), { [PROCESSOR_HEADERS.widths]: '320,640,1280' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await res.formData();
    expect([...form.keys()][0]).toBe('manifest');
    const manifest = processManifestSchema.parse(JSON.parse(form.get('manifest') as string));
    expect(manifest.variants.map((v) => v.variant)).toEqual(['w320', 'w640']);
    for (const variant of manifest.variants) {
      const file = form.get(variant.field) as File;
      expect(file.type).toBe('image/webp');
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.length).toBe(variant.byteSize);
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual([
        'webp',
        variant.width,
        variant.height,
      ]);
    }
  });

  it('rejects a decompression bomb with a typed, non-retryable 422', async () => {
    const res = await post(new Uint8Array(pngBomb()), {
      [PROCESSOR_HEADERS.expectedMime]: 'image/png',
    });
    expect(res.status).toBe(422);
    const body = processorErrorBodySchema.parse(await res.json());
    expect(body.error).toMatchObject({ code: 'too_many_pixels', retryable: false });
  });

  it('rejects oversized bodies with 413 before processing', async () => {
    const res = await post(new Uint8Array(6_000_000));
    expect(res.status).toBe(413);
    expect(processorErrorBodySchema.parse(await res.json()).error.code).toBe('file_too_large');
  });

  it('rejects invalid parameters and unknown routes', async () => {
    const bad = await post(new Uint8Array([1, 2, 3]), { [PROCESSOR_HEADERS.widths]: '300' });
    expect(bad.status).toBe(400);
    expect(processorErrorBodySchema.parse(await bad.json()).error.code).toBe('bad_request');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/process`)).status).toBe(405);
  });

  it('answers health checks', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('sheds load with a retryable 503 when a job is already running', async () => {
    const busy = createServer({ log: () => {}, maxConcurrentJobs: 0 });
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    try {
      const port = (busy.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/process`, { method: 'POST', body: 'x' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.json()).toMatchObject({
        error: { code: 'processor_busy', retryable: true },
      });
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });
});
