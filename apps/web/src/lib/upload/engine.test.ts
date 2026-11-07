import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeUploadRef, type DraftStore, type StoredUploadRef } from '../draft-store';
import { backoffDelay, parseRetryAfter } from './backoff';
import { AdaptiveConcurrency, baseConcurrency } from './concurrency';
import { UploadEngine, type UploadEngineOptions } from './engine';
import { apiError, FakeLumra, photo, readPrefix, uuid } from './test-fakes';

const MIB = 1024 * 1024;

function engineFor(fake: FakeLumra, options: Partial<UploadEngineOptions> = {}) {
  return new UploadEngine({
    api: fake.api,
    transport: fake.transport,
    mode: 'guest',
    galleryId: fake.galleryId,
    hasher: null,
    maxConcurrency: 3,
    random: () => 0.5,
    createClientId: uuid,
    readPrefix,
    pollIntervalMs: 1000,
    ...options,
  });
}

/** Lets queued promises and (fake) timers run until the engine is idle. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

/** In-memory DraftStore (the IndexedDB implementation has its own tests). */
function memoryStore(): DraftStore {
  const uploads = new Map<string, StoredUploadRef>();
  return {
    getDraft: async () => null,
    saveDraft: async () => {},
    clear: async () => uploads.clear(),
    putUpload: async (ref) => {
      uploads.set(ref.clientId, sanitizeUploadRef(ref));
    },
    getUpload: async (id) => uploads.get(id) ?? null,
    listUploads: async (galleryId) =>
      [...uploads.values()].filter((r) => r.galleryId === galleryId),
    deleteUpload: async (id) => {
      uploads.delete(id);
    },
    close: () => {},
  };
}

const states = (engine: UploadEngine) => engine.getSnapshot().items.map((i) => i.state);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('backoff helpers', () => {
  it('uses capped exponential delays with equal jitter', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(3, () => 0.5)).toBe(3000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0)).toBe(15_000);
  });

  it('parses Retry-After seconds and dates, clamped', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('99999')).toBe(120_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('concurrency', () => {
  it('starts at 3 desktop / 2 mobile and drops on slow connections', () => {
    expect(baseConcurrency(false)).toBe(3);
    expect(baseConcurrency(true)).toBe(2);
    expect(baseConcurrency(false, { effectiveType: '3g' })).toBe(2);
    expect(baseConcurrency(false, { effectiveType: '2g' })).toBe(1);
    expect(baseConcurrency(true, { saveData: true })).toBe(1);
  });

  it('adapts down on errors and recovers after successes', () => {
    const c = new AdaptiveConcurrency(3, 2);
    c.onError();
    c.onError();
    c.onError();
    expect(c.limit).toBe(1);
    c.onSuccess();
    c.onSuccess();
    expect(c.limit).toBe(2);
  });
});

describe('UploadEngine', () => {
  it('moves a file through queued → uploading → uploaded → processing → ready', async () => {
    const fake = new FakeLumra();
    const engine = engineFor(fake);
    const seen = new Set<string>();
    engine.subscribe(() => engine.getSnapshot().items.forEach((i) => seen.add(i.state)));

    const result = await engine.addFiles([photo('a.jpg', 1000)]);
    expect(result).toEqual({ added: 1, rejected: [] });
    await settle();
    expect(states(engine)).toEqual(['uploaded']);
    expect(fake.calls).toEqual(['intent:a.jpg', 'sign:1', 'complete']);

    fake.setMediaStatus('processing');
    await settle(1000);
    expect(states(engine)).toEqual(['processing']);
    fake.setMediaStatus('ready');
    await settle(1500);
    expect(states(engine)).toEqual(['ready']);
    expect([...seen]).toEqual(expect.arrayContaining(['queued', 'uploading', 'uploaded']));
    expect(engine.getSnapshot().totals).toMatchObject({
      totalBytes: 1000,
      uploadedBytes: 1000,
      percent: 100,
    });
    engine.dispose();
  });

  it('rejects unsupported files before any request (FR-M08)', async () => {
    const fake = new FakeLumra();
    const engine = engineFor(fake, { readPrefix: undefined });
    const result = await engine.addFiles([
      new File(['not a photo'], 'clip.mov', { type: 'video/quicktime' }),
      new File(['GIF89a......'], 'fake.jpg', { type: 'image/jpeg' }),
    ]);
    expect(result.added).toBe(0);
    expect(result.rejected.map((r) => r.code)).toEqual([
      'unsupported_extension',
      'unsupported_type',
    ]);
    expect(result.rejected[0]!.message).toMatch(/isn’t a supported photo/);
    expect(fake.calls).toEqual([]);
    engine.dispose();
  });

  it('uploads multipart files part by part and completes with ordered ETags', async () => {
    const fake = new FakeLumra();
    const engine = engineFor(fake);
    await engine.addFiles([photo('big.jpg', 20 * MIB)]);
    await settle();
    expect(states(engine)).toEqual(['uploaded']);
    expect(fake.calls).toEqual(['intent:big.jpg', 'sign:1,2,3', 'complete']);
    const intent = [...fake.intents.values()][0]!;
    expect([...intent.parts.keys()]).toEqual([1, 2, 3]);
    engine.dispose();
  });

  it('retries a failed part with jittered backoff, then succeeds', async () => {
    const fake = new FakeLumra();
    fake.putFailures = [{ status: 500 }, { status: 0 }];
    const random = vi.fn(() => 0.5);
    const engine = engineFor(fake, { random });
    await engine.addFiles([photo('a.jpg', 20 * MIB)]);
    await settle();
    expect(states(engine)).toEqual(['uploading']);
    // attempt 0 → 375 ms (cap 500, jitter 0.5), attempt 1 → 750 ms
    await settle(374);
    expect(fake.putCount).toBe(1);
    await settle(1);
    expect(fake.putCount).toBe(2);
    await settle(750);
    expect(states(engine)).toEqual(['uploaded']);
    expect(random).toHaveBeenCalledTimes(2);
    // Each failure re-signs the part (the URL may have expired).
    expect(fake.calls.filter((c) => c.startsWith('sign:'))).toEqual([
      'sign:1,2,3',
      'sign:1,2,3',
      'sign:1,2,3',
    ]);
    engine.dispose();
  });

  it('marks a file failed (recoverable) after too many part failures, and retry resumes it', async () => {
    const fake = new FakeLumra();
    fake.putFailures = Array.from({ length: 3 }, () => ({ status: 503 }));
    const engine = engineFor(fake, { maxPartAttempts: 3 });
    await engine.addFiles([photo('a.jpg', 20 * MIB)]);
    await settle(10_000);
    const [item] = engine.getSnapshot().items;
    expect(item!.state).toBe('failed');
    expect(item!.error).toMatchObject({ code: 'upload_interrupted', retryable: true });
    // Concurrency adapted down after repeated errors.
    expect(engine.getSnapshot().concurrency).toBe(1);

    engine.retry(item!.clientId);
    await settle();
    expect(states(engine)).toEqual(['uploaded']);
    expect(fake.intents.size).toBe(1); // same clientId → same intent
    expect(fake.calls).toContain('state'); // reconciled with the server before re-uploading
    engine.dispose();
  });

  it('honours Retry-After on 429 from the API', async () => {
    const fake = new FakeLumra();
    fake.failNext.createIntent = [apiError(429, 'rate_limited', 'Slow down', {}, true, 5000)];
    const engine = engineFor(fake);
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle(4999);
    expect(fake.calls).toEqual(['intent:a.jpg']);
    await settle(1);
    expect(states(engine)).toEqual(['uploaded']);
    engine.dispose();
  });

  it('honours Retry-After on a throttled part PUT', async () => {
    const fake = new FakeLumra();
    fake.putFailures = [{ status: 429, retryAfterMs: 8000 }];
    const engine = engineFor(fake);
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle(7999);
    expect(states(engine)).toEqual(['uploading']);
    await settle(1);
    expect(states(engine)).toEqual(['uploaded']);
    engine.dispose();
  });

  it('runs at most `limit` files concurrently', async () => {
    const fake = new FakeLumra();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.onPut = () => gate;
    const engine = engineFor(fake, { maxConcurrency: 2 });
    await engine.addFiles([1, 2, 3, 4, 5].map((n) => photo(`p${n}.jpg`, 1000 + n)));
    await settle();
    expect(fake.activePuts).toBe(2);
    expect(engine.getSnapshot().totals).toMatchObject({ uploading: 2, queued: 3 });
    release();
    await settle();
    expect(fake.maxActivePuts).toBe(2);
    expect(engine.getSnapshot().totals.done).toBe(5);
    engine.dispose();
  });

  it('cancel aborts the in-flight PUT and releases the reservation', async () => {
    const fake = new FakeLumra();
    fake.onPut = (request) =>
      new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
      );
    const engine = engineFor(fake);
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle();
    const [item] = engine.getSnapshot().items;
    engine.cancel(item!.clientId);
    await settle();
    expect(states(engine)).toEqual(['cancelled']);
    expect(fake.calls).toContain('abort');
    expect(fake.quota.reservedFiles).toBe(0);
    engine.remove(item!.clientId);
    expect(engine.getSnapshot().items).toEqual([]);
    engine.dispose();
  });

  it('prompts sign-in on the 21st guest file without reserving it (§14.2-2)', async () => {
    const fake = new FakeLumra();
    const engine = engineFor(fake);
    const files = Array.from({ length: 21 }, (_, n) => photo(`p${n}.jpg`, 1000 + n));
    await engine.addFiles(files);
    await settle();
    const snapshot = engine.getSnapshot();
    expect(snapshot.totals.done).toBe(20);
    expect(snapshot.items[20]!.state).toBe('failed');
    expect(snapshot.items[20]!.error).toMatchObject({ code: 'quota_exceeded', requiresAuth: true });
    expect(snapshot.authPrompt?.reason).toBe('guest_file_limit');
    expect(fake.calls.filter((c) => c.startsWith('intent:'))).toHaveLength(20);
    engine.dispose();
  });

  it('turns a server quota_exceeded into the sign-in prompt state', async () => {
    const fake = new FakeLumra();
    fake.quota = { reservedFiles: 20, reservedBytes: 1 }; // e.g. another tab used the quota
    const engine = engineFor(fake, { maxConcurrency: 1 });
    await engine.addFiles([photo('a.jpg', 1000), photo('b.jpg', 1001)]);
    await settle();
    const snapshot = engine.getSnapshot();
    expect(snapshot.authPrompt).toMatchObject({ reason: 'guest_file_limit' });
    expect(snapshot.items.map((i) => i.error?.code)).toEqual(['quota_exceeded', 'quota_exceeded']);
    // The file-limit refusal is not repeated for every queued file.
    expect(fake.calls.filter((c) => c.startsWith('intent:'))).toHaveLength(1);
    engine.dispose();
  });

  it('shows 401 as a sign-in prompt and 404 as a non-retryable failure', async () => {
    const fake = new FakeLumra();
    fake.failNext.createIntent = [
      apiError(401, 'unauthenticated', 'This draft has expired.', { reason: 'draft_expired' }),
    ];
    const engine = engineFor(fake);
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle();
    expect(engine.getSnapshot().authPrompt?.reason).toBe('draft_expired');
    engine.dispose();

    const other = engineFor(fake, { galleryId: uuid() });
    await other.addFiles([photo('b.jpg', 1000)]);
    await settle();
    expect(other.getSnapshot().items[0]!.error).toMatchObject({
      code: 'not_found',
      retryable: false,
    });
    other.dispose();
  });

  it('waits for the gallery before uploading', async () => {
    const fake = new FakeLumra();
    const engine = engineFor(fake, { galleryId: null });
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle();
    expect(states(engine)).toEqual(['queued']);
    engine.setGallery(fake.galleryId);
    await settle();
    expect(states(engine)).toEqual(['uploaded']);
    engine.dispose();
  });

  it('sends the checksum when the hasher produces one', async () => {
    const fake = new FakeLumra();
    const complete = vi.spyOn(fake.api, 'complete');
    const engine = engineFor(fake, { hasher: async () => 'a'.repeat(64) });
    await engine.addFiles([photo('a.jpg', 1000)]);
    await settle();
    expect(complete.mock.calls[0]![1]).toEqual({ parts: [], checksum: 'a'.repeat(64) });
    engine.dispose();
  });

  describe('resume after reload', () => {
    let store: DraftStore;
    beforeEach(() => {
      store = memoryStore();
    });

    it('persists progress refs, asks for the file again and skips parts R2 already has', async () => {
      const fake = new FakeLumra();
      // Part 1 lands, then the "tab closes" while part 2 is in flight.
      let puts = 0;
      fake.onPut = (request) => {
        puts += 1;
        if (puts >= 2) {
          return new Promise((_, reject) =>
            request.signal.addEventListener('abort', () =>
              reject(new DOMException('x', 'AbortError')),
            ),
          );
        }
      };
      const file = photo('big.jpg', 20 * MIB, 1234);
      const first = engineFor(fake, { store });
      await first.addFiles([file]);
      await settle();
      first.dispose();
      await vi.advanceTimersByTimeAsync(0);

      const refs = await store.listUploads(fake.galleryId);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ name: 'big.jpg', size: 20 * MIB, lastModified: 1234 });
      expect(refs[0]!.completedParts.map((p) => p.number)).toEqual([1]);
      expect(JSON.stringify(refs[0])).not.toContain('https://'); // no presigned URLs

      fake.onPut = null;
      fake.calls.length = 0;
      fake.putCount = 0;
      const second = engineFor(fake, { store });
      expect(await second.restore()).toBe(1);
      expect(states(second)).toEqual(['awaiting_file']);

      // A different file (lastModified differs) doesn't match: it's added as a new upload.
      const res = await second.resumeWith([file]);
      expect(res.resumed).toBe(1);
      await settle();
      expect(states(second)).toEqual(['uploaded']);
      expect(fake.calls).toEqual(['state', 'sign:2,3', 'complete']);
      expect(fake.putCount).toBe(2);
      second.dispose();
    });

    it('restarts with a new intent when the old one was aborted server-side', async () => {
      const fake = new FakeLumra();
      fake.onPut = (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          ),
        );
      const file = photo('a.jpg', 1000, 99);
      const first = engineFor(fake, { store });
      await first.addFiles([file]);
      await settle();
      first.dispose();
      await vi.advanceTimersByTimeAsync(0);
      for (const intent of fake.intents.values()) intent.status = 'expired';

      fake.onPut = null;
      const second = engineFor(fake, { store });
      await second.restore();
      await second.resumeWith([file]);
      await settle();
      expect(states(second)).toEqual(['uploaded']);
      expect(fake.intents.size).toBe(2);
      second.dispose();
    });
  });
});
