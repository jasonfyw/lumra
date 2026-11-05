import { describe, expect, it, vi } from 'vitest';
import type { GalleryAccessState } from '@lumra/contracts';
import {
  AccessStateUnavailableError,
  createKvGalleryAccessStore,
  evaluateGalleryAccess,
  galleryAccessKey,
  writeGalleryAccessState,
  type KvReader,
} from './access-state';

const GALLERY = '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10';
const state: GalleryAccessState = {
  accessVersion: 2,
  deleted: false,
  expiresAt: null,
  deliverySuspended: false,
  updatedAt: '2026-11-05T12:00:00.000Z',
};

function fakeKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const kv = {
    data,
    fail: false,
    get: vi.fn(async (key: string) => {
      if (kv.fail) throw new Error('KV down');
      return data.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
  return kv;
}

describe('galleryAccessKey', () => {
  it('builds gallery:{id} and rejects non-uuids', () => {
    expect(galleryAccessKey(GALLERY)).toBe(`gallery:${GALLERY}`);
    expect(() => galleryAccessKey('../x')).toThrow();
  });
});

describe('createKvGalleryAccessStore', () => {
  it('reads, memoizes for at most 5 s, then re-reads', async () => {
    const kv = fakeKv({ [`gallery:${GALLERY}`]: JSON.stringify(state) });
    let now = 0;
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 60_000, clock: () => now });
    expect(await store.get(GALLERY)).toEqual(state);
    now = 4_999;
    await store.get(GALLERY);
    expect(kv.get).toHaveBeenCalledTimes(1);
    now = 5_000; // memo TTL is clamped to 5 s even though 60 s was requested
    await store.get(GALLERY);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('returns null for missing state', async () => {
    const store = createKvGalleryAccessStore(fakeKv());
    expect(await store.get(GALLERY)).toBeNull();
  });

  it('fails closed on read errors and corrupt documents, without memoizing errors', async () => {
    const kv = fakeKv({ [`gallery:${GALLERY}`]: JSON.stringify(state) });
    kv.fail = true;
    const store = createKvGalleryAccessStore(kv);
    await expect(store.get(GALLERY)).rejects.toBeInstanceOf(AccessStateUnavailableError);
    kv.fail = false;
    expect(await store.get(GALLERY)).toEqual(state);

    const corrupt = createKvGalleryAccessStore(
      fakeKv({ [`gallery:${GALLERY}`]: JSON.stringify({ accessVersion: 'x' }) }),
    );
    await expect(corrupt.get(GALLERY)).rejects.toBeInstanceOf(AccessStateUnavailableError);
    const notJson = createKvGalleryAccessStore(fakeKv({ [`gallery:${GALLERY}`]: '{' }));
    await expect(notJson.get(GALLERY)).rejects.toBeInstanceOf(AccessStateUnavailableError);
  });

  it('accepts a Workers-style KV binding structurally', () => {
    const binding: KvReader = { get: async () => null };
    expect(createKvGalleryAccessStore(binding)).toBeTruthy();
  });
});

describe('evaluateGalleryAccess', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  it.each([
    [null, 2, 'not_found'],
    [{ ...state, deleted: true }, 2, 'not_found'],
    [state, 1, 'revoked'],
    [state, 3, 'revoked'],
    [{ ...state, expiresAt: '2026-11-05T12:00:00Z' }, 2, 'expired'],
    [{ ...state, deliverySuspended: true }, 2, 'suspended'],
    [{ ...state, expiresAt: '2026-11-05T12:00:01Z' }, 2, 'allow'],
    [state, 2, 'allow'],
  ] as const)('%j with token version %d → %s', (s, version, expected) => {
    expect(evaluateGalleryAccess(s, version, now)).toBe(expected);
  });
});

describe('writeGalleryAccessState', () => {
  it('writes the validated document via a binding', async () => {
    const kv = fakeKv();
    await writeGalleryAccessState({ binding: kv }, GALLERY, state);
    expect(JSON.parse(kv.data.get(`gallery:${GALLERY}`) ?? '')).toEqual(state);
    await expect(
      writeGalleryAccessState({ binding: kv }, GALLERY, { ...state, accessVersion: -1 }),
    ).rejects.toThrow();
  });

  it('writes via the Cloudflare KV REST API without leaking the token on failure', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ success: true }),
    );
    const rest = {
      accountId: 'acc123',
      namespaceId: 'ns456',
      apiToken: 'secret-api-token',
      fetch: fetchMock as unknown as typeof fetch,
    };
    await writeGalleryAccessState({ rest }, GALLERY, state);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/gallery%3A${GALLERY}`,
    );
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual(state);

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    const error = await writeGalleryAccessState({ rest }, GALLERY, state).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain('secret-api-token');
  });
});
