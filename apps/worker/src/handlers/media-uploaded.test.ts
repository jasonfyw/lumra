import { describe, expect, it, vi } from 'vitest';
import type {
  CompleteProcessingInput,
  CompleteProcessingResult,
  MediaForProcessing,
  MediaPipelineRepository,
} from '@lumra/db';
import type { MediaStatus } from '@lumra/contracts';
import { derivativeObjectKey } from '@lumra/media';
import {
  handleMediaUploaded,
  type DerivativesStore,
  type MediaUploadedDeps,
  type OriginalsStore,
} from './media-uploaded';
import {
  TransientProcessorError,
  type ProcessInput,
  type ProcessResult,
} from '../processor-client';

const mediaId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const galleryId = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
const originalKey = `originals/owner-123456/${galleryId}/${mediaId}/source`;
const message = {
  type: 'media.uploaded' as const,
  mediaId,
  traceId: 'req-1',
  dedupeKey: `media.uploaded:${mediaId}`,
};

/** Minimal JPEG prefix that passes the authoritative sniff (SOI + SOF0 4000×3000). */
function jpegBytes(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03, 0x01, 0x22, 0x00, 0x02,
    0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

/** In-memory media row + variant table with the same guarded semantics as the SQL repo. */
class FakeRepo implements MediaPipelineRepository {
  row: MediaForProcessing & { failureCode?: string };
  variants = new Map<string, string>();
  completed: CompleteProcessingInput[] = [];
  /** Hook run at the start of complete(), e.g. to simulate a concurrent delete. */
  beforeComplete?: () => void;

  constructor(status: MediaStatus = 'uploaded') {
    this.row = {
      id: mediaId,
      galleryId,
      status,
      mime: 'image/jpeg',
      byteSize: 1000,
      originalKey,
      deleted: false,
    };
  }

  async getForProcessing(id: string) {
    return id === this.row.id ? { ...this.row } : null;
  }

  async markProcessing() {
    if (this.row.deleted || !['uploaded', 'processing'].includes(this.row.status)) return false;
    this.row.status = 'processing';
    return true;
  }

  async complete(input: CompleteProcessingInput): Promise<CompleteProcessingResult> {
    this.beforeComplete?.();
    if (this.row.deleted) return { status: 'discarded', reason: 'deleted' };
    if (this.row.status !== 'processing') return { status: 'discarded', reason: 'not_processing' };
    const stale = [...this.variants.values()].filter(
      (k) => !input.variants.some((v) => v.objectKey === k),
    );
    this.variants = new Map(input.variants.map((v) => [v.variant, v.objectKey]));
    this.row.status = 'ready';
    this.completed.push(input);
    return { status: 'committed', staleObjectKeys: stale };
  }

  async markFailed(_id: string, code: Parameters<MediaPipelineRepository['markFailed']>[1]) {
    if (this.row.deleted || !['uploaded', 'processing'].includes(this.row.status)) return false;
    this.row.status = 'failed';
    this.row.failureCode = code;
    return true;
  }
}

class FakeOriginals implements OriginalsStore {
  constructor(public bytes: Uint8Array | null = jpegBytes()) {}
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    if (key !== originalKey || !this.bytes) return null;
    const all = this.bytes;
    const slice = options?.range
      ? all.subarray(options.range.offset, options.range.offset + options.range.length)
      : all;
    return {
      size: all.length,
      body: new Blob([new Uint8Array(slice)]).stream(),
      arrayBuffer: async () => new Uint8Array(slice).buffer as ArrayBuffer,
    };
  }
}

class FakeDerivatives implements DerivativesStore {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value);
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function okResult(): ProcessResult {
  const variants = [
    { variant: 'w320' as const, width: 320, height: 240 },
    { variant: 'w640' as const, width: 640, height: 480 },
  ];
  return {
    ok: true,
    manifest: {
      mediaId,
      source: {
        mime: 'image/jpeg',
        width: 4000,
        height: 3000,
        orientation: 1,
        takenAt: '2024-05-06T05:08:09.000Z',
      },
      encoding: { format: 'webp', quality: 80, pipelineVersion: 1 },
      variants: variants.map((v) => ({ ...v, field: v.variant, mime: 'image/webp', byteSize: 3 })),
    },
    files: variants.map((v) => ({
      ...v,
      field: v.variant,
      mime: 'image/webp' as const,
      byteSize: 3,
      bytes: new Uint8Array([1, 2, 3]),
    })),
  };
}

function setup(
  status: MediaStatus = 'uploaded',
  process?: (input: ProcessInput) => Promise<ProcessResult>,
) {
  const repo = new FakeRepo(status);
  const originals = new FakeOriginals();
  const derivatives = new FakeDerivatives();
  const processor = { process: vi.fn(process ?? (async () => okResult())) };
  const deps: MediaUploadedDeps = { repo, originals, derivatives, processor, log: () => {} };
  return { repo, originals, derivatives, processor, deps };
}

describe('handleMediaUploaded', () => {
  it('processes an uploaded photo: derivatives in R2, variants + ready in one commit', async () => {
    const { repo, derivatives, processor, deps } = setup();
    expect(await handleMediaUploaded(message, deps)).toBe('ready');

    const call = processor.process.mock.calls[0]![0];
    expect(call).toMatchObject({
      mediaId,
      expectedMime: 'image/jpeg',
      widths: [320, 640, 1280, 2048],
    });
    expect(repo.row.status).toBe('ready');
    const keys = [
      derivativeObjectKey(galleryId, mediaId, 'w320'),
      derivativeObjectKey(galleryId, mediaId, 'w640'),
    ];
    expect([...derivatives.objects.keys()].sort()).toEqual(keys.sort());
    expect(repo.completed[0]).toMatchObject({
      mediaId,
      mime: 'image/jpeg',
      width: 4000,
      height: 3000,
      orientation: 1,
      takenAt: '2024-05-06T05:08:09.000Z',
    });
    expect(repo.completed[0]!.variants.map((v) => v.objectKey).sort()).toEqual(keys.sort());
  });

  it('is idempotent: a redelivery of a ready media is acked without work', async () => {
    const { repo, derivatives, processor, deps } = setup();
    await handleMediaUploaded(message, deps);
    const before = new Map(derivatives.objects);
    expect(await handleMediaUploaded(message, deps)).toBe('already_ready');
    expect(processor.process).toHaveBeenCalledOnce();
    expect(derivatives.objects).toEqual(before);
    expect(repo.completed).toHaveLength(1);
  });

  it('re-runs safely when redelivered while still processing (crash/retry)', async () => {
    const { repo, derivatives, deps } = setup('processing');
    expect(await handleMediaUploaded(message, deps)).toBe('ready');
    expect(repo.row.status).toBe('ready');
    expect(derivatives.objects.size).toBe(2);
  });

  it('writes nothing when the media is deleted mid-processing and removes uploaded objects', async () => {
    const { repo, derivatives, deps } = setup();
    repo.beforeComplete = () => {
      repo.row.deleted = true;
      repo.row.status = 'deleting';
    };
    expect(await handleMediaUploaded(message, deps)).toBe('discarded_deleted');
    expect(repo.completed).toHaveLength(0);
    expect(repo.variants.size).toBe(0);
    expect(derivatives.objects.size).toBe(0);
  });

  it('skips deleted media and galleries before doing any work', async () => {
    const { repo, processor, deps } = setup();
    repo.row.deleted = true;
    expect(await handleMediaUploaded(message, deps)).toBe('skipped_deleted');
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('acks unknown, failed and not-yet-uploaded media without processing', async () => {
    const missing = setup();
    expect(await handleMediaUploaded({ ...message, mediaId: galleryId }, missing.deps)).toBe(
      'skipped_missing',
    );
    const failed = setup('failed');
    expect(await handleMediaUploaded(message, failed.deps)).toBe('already_failed');
    const reserved = setup('reserved');
    expect(await handleMediaUploaded(message, reserved.deps)).toBe('skipped_not_uploaded');
    for (const s of [missing, failed, reserved]) expect(s.processor.process).not.toHaveBeenCalled();
  });

  it('marks failed (non-retryable) when the authoritative sniff rejects the bytes', async () => {
    const { repo, originals, processor, deps } = setup();
    originals.bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await handleMediaUploaded(message, deps)).toBe('rejected');
    expect(repo.row).toMatchObject({ status: 'failed', failureCode: 'unsupported_type' });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('marks failed with the processor rejection code', async () => {
    const { repo, derivatives, deps } = setup('uploaded', async () => ({
      ok: false,
      code: 'too_many_pixels',
    }));
    expect(await handleMediaUploaded(message, deps)).toBe('rejected');
    expect(repo.row).toMatchObject({ status: 'failed', failureCode: 'too_many_pixels' });
    expect(derivatives.objects.size).toBe(0);
  });

  it('throws on transient processor errors so the queue retries, leaving the row processing', async () => {
    const { repo, derivatives, deps } = setup('uploaded', async () => {
      throw new TransientProcessorError('processor 503 processor_busy');
    });
    await expect(handleMediaUploaded(message, deps)).rejects.toBeInstanceOf(
      TransientProcessorError,
    );
    expect(repo.row.status).toBe('processing');
    expect(derivatives.objects.size).toBe(0);
  });

  it('cleans up partial uploads when an R2 write fails, then retries', async () => {
    const { repo, derivatives, deps } = setup();
    let puts = 0;
    derivatives.put = async (key, value) => {
      if (++puts === 2) throw new Error('R2 unavailable');
      derivatives.objects.set(key, value);
    };
    await expect(handleMediaUploaded(message, deps)).rejects.toThrow('R2 unavailable');
    expect(derivatives.objects.size).toBe(0);
    expect(repo.row.status).toBe('processing');
  });

  it('throws (retry) when the original object is not visible', async () => {
    const { originals, deps } = setup();
    originals.bytes = null;
    await expect(handleMediaUploaded(message, deps)).rejects.toThrow('original object not found');
  });

  it('deletes objects of variants that a newer pipeline no longer references', async () => {
    const { repo, derivatives, deps } = setup('processing');
    const staleKey = `derivatives/${galleryId}/${mediaId}/w320old0001.webp`;
    repo.variants.set('w320', staleKey);
    derivatives.objects.set(staleKey, new Uint8Array([9]));
    expect(await handleMediaUploaded(message, deps)).toBe('ready');
    expect(derivatives.objects.has(staleKey)).toBe(false);
  });
});
