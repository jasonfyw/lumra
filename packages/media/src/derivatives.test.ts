import { describe, expect, it } from 'vitest';
import { DERIVATIVE_ENCODING } from '@lumra/config';
import {
  derivativeObjectKey,
  derivativeVariantHash,
  planDerivatives,
  variantForWidth,
} from './derivatives';
import { isStorageKey } from './keys';

describe('planDerivatives', () => {
  it('produces every width that fits and never upscales', () => {
    expect(planDerivatives(4032).map((d) => d.variant)).toEqual(['w320', 'w640', 'w1280', 'w2048']);
    expect(planDerivatives(1500).map((d) => [d.variant, d.outputWidth])).toEqual([
      ['w320', 320],
      ['w640', 640],
      ['w1280', 1280],
    ]);
    expect(planDerivatives(640).map((d) => d.variant)).toEqual(['w320', 'w640']);
  });

  it('keeps the smallest variant at native width for tiny sources', () => {
    expect(planDerivatives(200)).toEqual([{ variant: 'w320', targetWidth: 320, outputWidth: 200 }]);
  });

  it('honours an explicit width subset and rejects bad input', () => {
    expect(planDerivatives(3000, [2048, 640]).map((d) => d.variant)).toEqual(['w640', 'w2048']);
    expect(() => planDerivatives(0)).toThrow();
    expect(() => planDerivatives(100, [])).toThrow();
    expect(() => variantForWidth(300)).toThrow();
  });
});

describe('derivativeVariantHash', () => {
  it('is stable and key-safe', () => {
    const hash = derivativeVariantHash('w640');
    expect(hash).toMatch(/^w640[a-z0-9]{7}$/);
    expect(derivativeVariantHash('w640')).toBe(hash);
    const key = derivativeObjectKey(
      '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f',
      '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      'w640',
    );
    expect(isStorageKey(key)).toBe(true);
    expect(key.endsWith(`/${hash}.webp`)).toBe(true);
  });

  it('changes with width, quality and pipeline version', () => {
    const base = derivativeVariantHash('w640');
    expect(derivativeVariantHash('w1280')).not.toBe(base);
    expect(derivativeVariantHash('w640', { ...DERIVATIVE_ENCODING, quality: 81 })).not.toBe(base);
    expect(
      derivativeVariantHash('w640', {
        ...DERIVATIVE_ENCODING,
        pipelineVersion: DERIVATIVE_ENCODING.pipelineVersion + 1,
      }),
    ).not.toBe(base);
  });
});
