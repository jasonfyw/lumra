import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatGigabytes } from './format';

describe('formatGigabytes (decimal GB)', () => {
  it.each([
    [0, '0 GB'],
    [-5, '0 GB'],
    [1, '< 0.01 GB'],
    [4_999_999, '< 0.01 GB'],
    [5_000_000, '0.01 GB'],
    [250_000_000, '0.25 GB'],
    [1_000_000_000, '1 GB'],
    [1_234_567_890, '1.23 GB'],
    [1_500_000_000_000, '1,500 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatGigabytes(bytes)).toBe(text);
  });
});

describe('formatBytes (decimal units)', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [999, '999 bytes'],
    [1_000, '1 KB'],
    [1_500_000, '1.5 MB'],
    [250_000_000, '250 MB'],
    [1_000_000_000, '1 GB'],
    [12_345_678_901, '12.3 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('formatDate', () => {
  it('formats in UTC', () => {
    expect(formatDate('2026-11-05T23:59:00Z')).toBe('Nov 5, 2026');
  });
});
