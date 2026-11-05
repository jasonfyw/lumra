import { describe, expect, it } from 'vitest';
import { contentDisposition, ifNoneMatchHits, parseRange } from './http';

describe('parseRange', () => {
  it.each([
    [null, 100, null],
    ['bytes=0-0', 100, { start: 0, end: 0 }],
    ['bytes=-200', 100, { start: 0, end: 99 }],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=0-', 0, 'unsatisfiable'],
    ['bytes=-1', 0, 'unsatisfiable'],
    ['bytes=5-1', 100, null],
    ['bytes=-', 100, null],
    ['items=0-1', 100, null],
    ['bytes=0-1, 3-4', 100, null],
    ['bytes=99999999999999999999-', 100, null],
  ] as const)('%s of %d → %j', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe('ifNoneMatchHits', () => {
  it('handles lists, weak tags and *', () => {
    expect(ifNoneMatchHits('"a", W/"b"', '"b"')).toBe(true);
    expect(ifNoneMatchHits('*', '"b"')).toBe(true);
    expect(ifNoneMatchHits('"c"', '"b"')).toBe(false);
    expect(ifNoneMatchHits(null, '"b"')).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('encodes per RFC 8187', () => {
    expect(contentDisposition('inline')).toBe('inline');
    expect(contentDisposition('attachment', "it's (1)*.jpg")).toBe(
      `attachment; filename="it's (1)*.jpg"; filename*=UTF-8''it%27s%20%281%29%2A.jpg`,
    );
  });
});
