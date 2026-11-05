import { describe, expect, it } from 'vitest';
import { selectCover, type CoverCandidate } from './cover';

const items: CoverCandidate[] = [
  { id: 'c', status: 'processing', uploadOrder: 1 },
  { id: 'b', status: 'ready', uploadOrder: 3 },
  { id: 'a', status: 'ready', uploadOrder: 2 },
  { id: 'd', status: 'failed', uploadOrder: 0 },
];

describe('selectCover', () => {
  it('uses the override when it is present and ready', () => {
    expect(selectCover(items, 'b')?.id).toBe('b');
  });

  it('falls back to the first ready item by upload order', () => {
    expect(selectCover(items, null)?.id).toBe('a');
    expect(selectCover(items, undefined)?.id).toBe('a');
    expect(selectCover(items, 'c')?.id).toBe('a'); // override not ready yet
    expect(selectCover(items, 'missing')?.id).toBe('a'); // override deleted
  });

  it('returns null (neutral placeholder) when nothing is ready', () => {
    expect(selectCover([], null)).toBeNull();
    expect(
      selectCover(
        items.filter((i) => i.status !== 'ready'),
        'c',
      ),
    ).toBeNull();
  });

  it('breaks upload-order ties deterministically by id', () => {
    const tied: CoverCandidate[] = [
      { id: 'y', status: 'ready', uploadOrder: 5 },
      { id: 'x', status: 'ready', uploadOrder: 5 },
    ];
    expect(selectCover(tied, null)?.id).toBe('x');
    expect(selectCover([...tied].reverse(), null)?.id).toBe('x');
  });
});
