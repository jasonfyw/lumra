import { publicGalleryResponseSchema } from '@lumra/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeGalleryFixture } from './gallery/fixture';
import DevGalleryPage from './gallery/page';
import { GET } from './placeholder/[w]/[h]/route';

const ctx = (w: string, h: string) => ({ params: Promise.resolve({ w, h }) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dev placeholder route', () => {
  it('returns a deterministic SVG of the requested size', async () => {
    const res = await GET(
      new Request('http://localhost/dev/placeholder/640/427?s=7'),
      ctx('640', '427'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('width="640" height="427"');
    const again = await GET(
      new Request('http://localhost/dev/placeholder/640/427?s=7'),
      ctx('640', '427'),
    );
    expect(await again.text()).toBe(body);
  });

  it('serves downloads as attachments', async () => {
    const res = await GET(
      new Request('http://localhost/dev/placeholder/60/40?s=3&download=1'),
      ctx('60', '40'),
    );
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('rejects invalid dimensions', async () => {
    for (const [w, h] of [
      ['0', '10'],
      ['10', '99999'],
      ['abc', '10'],
    ] as const) {
      const res = await GET(new Request(`http://localhost/dev/placeholder/${w}/${h}`), ctx(w, h));
      expect(res.status).toBe(404);
    }
  });

  it('is 404 in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await GET(new Request('http://localhost/dev/placeholder/10/10'), ctx('10', '10'));
    expect(res.status).toBe(404);
  });
});

describe('dev gallery page', () => {
  it('is 404 in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(DevGalleryPage({ searchParams: Promise.resolve({}) })).rejects.toThrow();
  });

  it('builds a contract-valid fixture with mixed statuses up to 2,000 items', () => {
    const fixture = makeGalleryFixture(5_000);
    expect(publicGalleryResponseSchema.parse(fixture).items).toHaveLength(2_000);
    const statuses = new Set(fixture.items.map((item) => item.status));
    expect(statuses).toEqual(new Set(['ready', 'pending', 'unavailable']));
    const ratios = fixture.items.map((item) => (item.width ?? 3) / (item.height ?? 2));
    expect(Math.max(...ratios)).toBeGreaterThanOrEqual(3); // panoramas
    expect(Math.min(...ratios)).toBeLessThan(1); // portraits
  });
});
