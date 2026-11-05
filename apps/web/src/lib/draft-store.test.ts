import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  matchesUploadRef,
  openDraftStore,
  sanitizeUploadRef,
  type DraftStore,
  type StoredUploadRef,
} from './draft-store';

const GALLERY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';

const ref = (overrides: Partial<StoredUploadRef> = {}): StoredUploadRef => ({
  clientId: CLIENT,
  galleryId: GALLERY,
  intentId: INTENT,
  mediaId: null,
  name: 'IMG_0001.HEIC',
  size: 12_000_000,
  type: 'image/heic',
  lastModified: 1_700_000_000_000,
  completedParts: [{ number: 1, etag: '"abc123"' }],
  status: 'uploading',
  updatedAt: 1,
  ...overrides,
});

let store: DraftStore;

beforeEach(async () => {
  store = (await openDraftStore(new IDBFactory()))!;
});

describe('draft store (IndexedDB)', () => {
  it('returns null when IndexedDB is unavailable', async () => {
    expect(await openDraftStore(undefined)).toBeNull();
  });

  it('saves and reads the current draft, hiding it once expired', async () => {
    const draftExpiresAt = '2026-11-06T10:00:00.000Z';
    await store.saveDraft({ galleryId: GALLERY, draftExpiresAt });
    expect(await store.getDraft(new Date('2026-11-05T10:00:00Z'))).toEqual({
      galleryId: GALLERY,
      draftExpiresAt,
    });
    expect(await store.getDraft(new Date('2026-11-06T10:00:00Z'))).toBeNull();
  });

  it('rejects a draft without a valid gallery id', async () => {
    await expect(
      store.saveDraft({ galleryId: 'nope', draftExpiresAt: new Date().toISOString() }),
    ).rejects.toThrow(TypeError);
  });

  it('stores upload references and lists them per gallery', async () => {
    await store.putUpload(ref());
    await store.putUpload(
      ref({ clientId: '44444444-4444-4444-8444-444444444444', galleryId: INTENT, updatedAt: 2 }),
    );
    expect(await store.getUpload(CLIENT)).toEqual(ref());
    expect((await store.listUploads(GALLERY)).map((r) => r.clientId)).toEqual([CLIENT]);
    await store.deleteUpload(CLIENT);
    expect(await store.getUpload(CLIENT)).toBeNull();
  });

  it('never persists file bytes, URLs or unknown fields', async () => {
    const polluted = {
      ...ref(),
      file: new Blob(['secret bytes']),
      signedUrl: 'https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeef',
      completedParts: [
        { number: 1, etag: '"abc123"', url: 'https://x' },
        { number: 0, etag: 'bad' },
        { number: 2, etag: '<script>' },
      ],
    } as unknown as StoredUploadRef;
    await store.putUpload(polluted);
    const stored = (await store.getUpload(CLIENT)) as unknown as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(Object.keys(ref()).sort());
    expect(JSON.stringify(stored)).not.toContain('X-Amz-Signature');
    expect(stored.completedParts).toEqual([{ number: 1, etag: '"abc123"' }]);
  });

  it('clear() removes the draft and all references', async () => {
    await store.saveDraft({ galleryId: GALLERY, draftExpiresAt: '2099-01-01T00:00:00Z' });
    await store.putUpload(ref());
    await store.clear();
    expect(await store.getDraft()).toBeNull();
    expect(await store.listUploads(GALLERY)).toEqual([]);
  });
});

describe('sanitizeUploadRef / matchesUploadRef', () => {
  it('validates ids, sizes and status', () => {
    expect(() => sanitizeUploadRef(ref({ clientId: 'x' }))).toThrow(TypeError);
    expect(() => sanitizeUploadRef(ref({ size: -1 }))).toThrow(TypeError);
    expect(() => sanitizeUploadRef(ref({ status: 'bogus' as StoredUploadRef['status'] }))).toThrow(
      TypeError,
    );
    expect(sanitizeUploadRef(ref({ intentId: 'not-a-uuid' })).intentId).toBeNull();
  });

  it('matches a reselected file by name, size and lastModified', () => {
    const file = { name: 'IMG_0001.HEIC', size: 12_000_000, lastModified: 1_700_000_000_000 };
    expect(matchesUploadRef(file, ref())).toBe(true);
    expect(matchesUploadRef({ ...file, size: 1 }, ref())).toBe(false);
  });
});
