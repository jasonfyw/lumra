import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_GALLERY } from '@lumra/config';
import type { PublicGalleryResponse, PublicMediaItem } from '@lumra/contracts';
import { unlockErrorMessage } from '@/app/g/[slug]/password-gate';
import { PublicGallery } from './public-gallery';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ready = (n: number, url?: string): PublicMediaItem => ({
  id: id(n),
  status: 'ready',
  width: 300,
  height: 200,
  uploadOrder: n,
  filename: `p${n}.jpg`,
  variants: url ? [{ width: 320, url }] : [],
});
const pending = (n: number): PublicMediaItem => ({
  ...ready(n),
  status: 'pending',
  width: null,
  height: null,
});
const gallery = {
  id: id(99),
  slug: 'abc',
  title: 'Autumn',
  coverMediaId: null,
  brandingVisible: true,
  contentVersion: 1,
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null, requestId: 'r' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PublicGallery', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    refresh.mockReset();
  });

  it('polls while items are pending and mints URLs once they are ready (§14.2-3)', async () => {
    const initial: PublicGalleryResponse = {
      gallery,
      items: [ready(1, '/m/one'), pending(2)],
      urlsExpireAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('?urls=0')) return json({ gallery, items: [ready(1), ready(2)] });
      const body = JSON.parse(String(init?.body)) as { mediaIds: string[] };
      return json({
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        items: body.mediaIds.map((m) => ({ id: m, variants: [{ width: 320, url: `/m/${m}` }] })),
        missing: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<PublicGallery slug="abc" initial={initial} />);
    expect(container.querySelector('[data-index="1"]')?.getAttribute('data-status')).toBe(
      'pending',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_GALLERY.pollIntervalMs + 500);
    });
    // The newly ready tile's mint is debounced; let it flush and resolve.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(calls).toContain('GET /api/v1/public/galleries/abc?urls=0');
    const tile = container.querySelector('[data-index="1"]')!;
    expect(tile.getAttribute('data-status')).toBe('ready');
    expect(calls.some((c) => c.startsWith('POST /api/v1/public/galleries/abc/media-tokens'))).toBe(
      true,
    );
    expect(tile.querySelector('img')?.getAttribute('src')).toBe(`/m/${id(2)}`);
    // Item 1 kept the URL it was rendered with (no needless re-download).
    expect(container.querySelector('[data-index="0"] img')?.getAttribute('src')).toBe('/m/one');

    // Nothing pending any more: polling stops.
    const before = calls.filter((c) => c.endsWith('?urls=0')).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_GALLERY.pollIntervalMs * 3);
    });
    expect(calls.filter((c) => c.endsWith('?urls=0')).length).toBe(before);
  });

  it('shows "Download all" only once a photo is ready (T25)', () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(json({ expiresAt: new Date().toISOString(), items: [], missing: [] })),
    );
    const { unmount } = render(
      <PublicGallery slug="abc" initial={{ gallery, items: [pending(1)] }} />,
    );
    expect(document.querySelector('button.lm-btn-primary')).toBeNull();
    unmount();
    render(<PublicGallery slug="abc" initial={{ gallery, items: [ready(1), pending(2)] }} />);
    expect(
      Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Download all'),
    ).toBe(true);
  });

  it('refreshes the route when the gallery expires mid-visit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(null, 410)),
    );
    render(<PublicGallery slug="abc" initial={{ gallery, items: [pending(1)] }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_GALLERY.pollIntervalMs + 500);
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('unlockErrorMessage', () => {
  it('maps codes to recipient copy', () => {
    expect(unlockErrorMessage(401, { error: { code: 'invalid_password' } })).toMatch(/not correct/);
    expect(
      unlockErrorMessage(429, {
        error: { code: 'rate_limited', details: { retryAfterSeconds: 120 } },
      }),
    ).toMatch(/wait 2 minutes/);
    expect(unlockErrorMessage(500, null)).toMatch(/Something went wrong/);
  });
});
