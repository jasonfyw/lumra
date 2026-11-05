import { describe, expect, it } from 'vitest';
import { buildResponsiveImage, pickVariantWidth } from './srcset';

const url = (w: number) => `https://media.example/t/abc?w=${w}`;

describe('pickVariantWidth', () => {
  it('picks the smallest derivative covering box width × DPR', () => {
    expect(pickVariantWidth(220, 1)).toBe(320);
    expect(pickVariantWidth(220, 2)).toBe(640);
    expect(pickVariantWidth(320, 1)).toBe(320);
    expect(pickVariantWidth(321, 1)).toBe(640);
    expect(pickVariantWidth(700, 2)).toBe(2048);
  });

  it('falls back to the largest variant and clamps DPR', () => {
    expect(pickVariantWidth(1200, 3)).toBe(2048);
    expect(pickVariantWidth(220, 0.5)).toBe(320); // DPR < 1 treated as 1
    expect(pickVariantWidth(220, Number.NaN)).toBe(320);
    expect(pickVariantWidth(220, 4, undefined, 2)).toBe(640); // capped at 2
  });

  it('respects the variants that actually exist', () => {
    expect(pickVariantWidth(500, 1, [320, 640])).toBe(640);
    expect(pickVariantWidth(900, 1, [640, 320, 640])).toBe(640);
    expect(pickVariantWidth(100, 1, [])).toBeNull();
  });
});

describe('buildResponsiveImage', () => {
  it('builds src, srcset and sizes from the layout box', () => {
    expect(buildResponsiveImage({ boxWidth: 219.6, dpr: 2 }, url)).toEqual({
      src: url(640),
      width: 640,
      srcSet: `${url(320)} 320w, ${url(640)} 640w, ${url(1280)} 1280w, ${url(2048)} 2048w`,
      sizes: '220px',
    });
  });

  it('only lists available variants and returns null when there are none', () => {
    expect(buildResponsiveImage({ boxWidth: 300, availableWidths: [640, 320] }, url)?.srcSet).toBe(
      `${url(320)} 320w, ${url(640)} 640w`,
    );
    expect(buildResponsiveImage({ boxWidth: 300, availableWidths: [] }, url)).toBeNull();
  });
});
