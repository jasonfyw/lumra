import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  InvalidOrderKeyError,
  compareSortKeys,
  isValidOrderKey,
  keyBetween,
  nKeysBetween,
  rebalanceKeys,
  reorder,
  type SortableItem,
} from './ordering';

function apply(items: SortableItem[], updates: SortableItem[]): SortableItem[] {
  const next = new Map(items.map((i) => [i.id, i.sortKey]));
  for (const u of updates) next.set(u.id, u.sortKey);
  return [...next].map(([id, sortKey]) => ({ id, sortKey }));
}

function orderOf(items: SortableItem[]): string[] {
  return [...items].sort((a, b) => compareSortKeys(a.sortKey, b.sortKey)).map((i) => i.id);
}

function assertStrictlyAscending(keys: string[]) {
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
}

/** Builds a valid ordered key list by random inserts, to exercise fractional keys too. */
const keyListArb = fc.array(fc.nat(), { minLength: 1, maxLength: 60 }).map((positions) => {
  const keys: string[] = [];
  for (const pos of positions) {
    const at = pos % (keys.length + 1);
    keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
  }
  return keys;
});

describe('keyBetween', () => {
  it('matches the reference algorithm on known values', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween('a0', 'a1')).toBe('a0V');
    expect(keyBetween('az', null)).toBe('b00');
    expect(keyBetween('a0', 'a0V')).toBe('a0G');
  });

  it('returns a valid key strictly between any two valid neighbours', () => {
    fc.assert(
      fc.property(keyListArb, fc.nat(), (keys, pick) => {
        const i = pick % (keys.length + 1);
        const a = keys[i - 1] ?? null;
        const b = keys[i] ?? null;
        const k = keyBetween(a, b);
        expect(isValidOrderKey(k)).toBe(true);
        if (a !== null) expect(a < k).toBe(true);
        if (b !== null) expect(k < b).toBe(true);
      }),
    );
  });

  it('is deterministic', () => {
    expect(keyBetween('a1', 'a2')).toBe(keyBetween('a1', 'a2'));
  });

  it('rejects invalid or out-of-order bounds', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow(InvalidOrderKeyError);
    expect(() => keyBetween('a1', 'a1')).toThrow(InvalidOrderKeyError);
    expect(() => keyBetween('a10', null)).toThrow(InvalidOrderKeyError); // trailing zero
    expect(() => keyBetween('!', null)).toThrow(InvalidOrderKeyError);
    expect(() => keyBetween('b0', null)).toThrow(InvalidOrderKeyError); // integer part too short
    expect(isValidOrderKey('a0')).toBe(true);
    expect(isValidOrderKey('a0-')).toBe(false);
    expect(isValidOrderKey(5)).toBe(false);
  });

  it('keeps keys short when repeatedly appending or prepending', () => {
    let end: string | null = null;
    let start: string | null = null;
    for (let i = 0; i < 2_000; i++) {
      end = keyBetween(end, null);
      start = keyBetween(null, start);
    }
    expect(end!.length).toBeLessThanOrEqual(4);
    expect(start!.length).toBeLessThanOrEqual(4);
  });
});

describe('nKeysBetween', () => {
  it('returns n ascending keys strictly inside the bounds', () => {
    fc.assert(
      fc.property(keyListArb, fc.nat(), fc.integer({ min: 0, max: 50 }), (keys, pick, n) => {
        const i = pick % (keys.length + 1);
        const a = keys[i - 1] ?? null;
        const b = keys[i] ?? null;
        const out = nKeysBetween(a, b, n);
        expect(out).toHaveLength(n);
        assertStrictlyAscending([...(a ? [a] : []), ...out, ...(b ? [b] : [])]);
      }),
    );
  });

  it('bulk-appends 2,000 keys after an existing tail and prepends before a head', () => {
    const tail = nKeysBetween('a5', null, 2_000);
    assertStrictlyAscending(['a5', ...tail]);
    expect(Math.max(...tail.map((k) => k.length))).toBeLessThanOrEqual(3);
    const head = nKeysBetween(null, 'a0', 2_000);
    assertStrictlyAscending([...head, 'a0']);
  });

  it('rejects invalid counts', () => {
    expect(() => nKeysBetween(null, null, -1)).toThrow(RangeError);
    expect(() => nKeysBetween(null, null, 1.5)).toThrow(RangeError);
  });
});

describe('reorder', () => {
  const items = (n: number) => rebalanceKeys(Array.from({ length: n }, (_, i) => `m${i}`));

  it('returns no updates when the order is unchanged', () => {
    const current = items(10);
    const ids = current.map((i) => i.id);
    expect(reorder(current, ids)).toEqual({ updates: [], rebalanced: false });
  });

  it('moves a single item to the start or end with a single update', () => {
    const current = items(10);
    const ids = current.map((i) => i.id);

    const toStart = ['m7', ...ids.filter((id) => id !== 'm7')];
    const r1 = reorder(current, toStart);
    expect(r1.rebalanced).toBe(false);
    expect(r1.updates.map((u) => u.id)).toEqual(['m7']);
    expect(orderOf(apply(current, r1.updates))).toEqual(toStart);

    const toEnd = [...ids.filter((id) => id !== 'm0'), 'm0'];
    const r2 = reorder(current, toEnd);
    expect(r2.updates.map((u) => u.id)).toEqual(['m0']);
    expect(orderOf(apply(current, r2.updates))).toEqual(toEnd);
  });

  it('achieves any requested permutation with unique keys, deterministically', () => {
    const arb = keyListArb.chain((keys) =>
      fc
        .shuffledSubarray(
          keys.map((_, i) => i),
          { minLength: keys.length, maxLength: keys.length },
        )
        .map((perm) => ({ keys, perm })),
    );
    fc.assert(
      fc.property(arb, ({ keys, perm }) => {
        const current = keys.map((sortKey, i) => ({ id: `id${i}`, sortKey }));
        const target = perm.map((i) => `id${i}`);
        const result = reorder(current, target);
        const next = apply(current, result.updates);
        expect(orderOf(next)).toEqual(target);
        expect(new Set(next.map((i) => i.sortKey)).size).toBe(next.length);
        expect(new Set(result.updates.map((u) => u.id)).size).toBe(result.updates.length);
        expect(reorder(current, target)).toEqual(result);
      }),
    );
  });

  it('handles 2,000 items: full reversal and single moves', () => {
    const current = items(2_000);
    const reversed = current.map((i) => i.id).reverse();
    const r = reorder(current, reversed);
    expect(orderOf(apply(current, r.updates))).toEqual(reversed);
    expect(r.updates).toHaveLength(1_999);

    fc.assert(
      fc.property(fc.nat(1_999), fc.nat(1_999), (from, to) => {
        const ids = current.map((i) => i.id);
        const [id] = ids.splice(from, 1);
        ids.splice(to, 0, id!);
        const res = reorder(current, ids);
        expect(res.updates.length).toBeLessThanOrEqual(1);
        expect(orderOf(apply(current, res.updates))).toEqual(ids);
      }),
      { numRuns: 50 },
    );
  });

  it('rebalances everything when keys would exceed the length threshold', () => {
    let current = items(3);
    let rebalancedAt = -1;
    // Repeatedly move the last item between the first two: the inserted key grows each round.
    for (let round = 0; round < 200 && rebalancedAt < 0; round++) {
      const ids = orderOf(current);
      const target = [ids[0]!, ids[2]!, ids[1]!];
      const res = reorder(current, target, { maxKeyLength: 8 });
      current = apply(current, res.updates);
      expect(orderOf(current)).toEqual(target);
      if (res.rebalanced) rebalancedAt = round;
    }
    expect(rebalancedAt).toBeGreaterThan(0);
    expect(Math.max(...current.map((i) => i.sortKey.length))).toBeLessThanOrEqual(8);
  });

  it('rejects ids that are not a permutation of the current items', () => {
    const current = items(3);
    expect(() => reorder(current, ['m0', 'm1'])).toThrow(InvalidOrderKeyError);
    expect(() => reorder(current, ['m0', 'm1', 'm1'])).toThrow(InvalidOrderKeyError);
    expect(() => reorder(current, ['m0', 'm1', 'x'])).toThrow(InvalidOrderKeyError);
    expect(() => reorder([...current, current[0]!], ['m0', 'm1', 'm2'])).toThrow(
      InvalidOrderKeyError,
    );
  });

  it('repairs duplicate and invalid legacy keys', () => {
    const current = [
      { id: 'a', sortKey: 'a0' },
      { id: 'b', sortKey: 'a0' },
      { id: 'c', sortKey: 'bad!' },
      { id: 'd', sortKey: 'a1' },
    ];
    const res = reorder(current, ['a', 'b', 'c', 'd']);
    const next = apply(current, res.updates);
    expect(orderOf(next)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.every((i) => isValidOrderKey(i.sortKey))).toBe(true);
  });
});
