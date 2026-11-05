import { BYTES_PER_GB, STORAGE_ESTIMATE } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { estimateStoredFootprintBytes } from './footprint';

describe('estimateStoredFootprintBytes', () => {
  it('adds the derivative overhead and per-item allowance', () => {
    expect(STORAGE_ESTIMATE).toEqual({
      derivativeOverheadBps: 2_500,
      derivativePerItemBytes: 100_000,
    });
    // 10 MB photo → 10 MB + 2.5 MB + 0.1 MB
    expect(estimateStoredFootprintBytes({ originalBytes: 10_000_000, items: 1 })).toBe(12_600_000);
    expect(estimateStoredFootprintBytes({ originalBytes: 0, items: 0 })).toBe(0);
  });

  it('rounds the proportional part up (never under-reserves)', () => {
    expect(estimateStoredFootprintBytes({ originalBytes: 1, items: 1 })).toBe(100_002);
    expect(estimateStoredFootprintBytes({ originalBytes: 3, items: 0 })).toBe(4);
  });

  it('is linear, so it can be applied to aggregates', () => {
    const a = estimateStoredFootprintBytes({ originalBytes: 40_000_000, items: 1 });
    const b = estimateStoredFootprintBytes({ originalBytes: 20_000_000, items: 1 });
    expect(estimateStoredFootprintBytes({ originalBytes: 60_000_000, items: 2 })).toBe(a + b);
  });

  it('a Free 1 GB cap fits roughly 79 × 10 MB photos', () => {
    const per = estimateStoredFootprintBytes({ originalBytes: 10_000_000, items: 1 });
    expect(Math.floor(BYTES_PER_GB / per)).toBe(79);
  });

  it('rejects negative or unsafe inputs', () => {
    expect(() => estimateStoredFootprintBytes({ originalBytes: -1, items: 0 })).toThrow();
    expect(() => estimateStoredFootprintBytes({ originalBytes: 1.5, items: 0 })).toThrow();
  });
});
