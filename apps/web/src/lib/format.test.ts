import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate } from './format';

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
