import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  applySelectClick,
  moveSelection,
  pruneSelection,
  rangeIds,
  toggleSelectAll,
} from './selection';

const ids = ['a', 'b', 'c', 'd', 'e'];
const sel = (...s: string[]) => ({ selected: new Set(s), anchor: s.at(-1) ?? null });

describe('applySelectClick', () => {
  it('plain click selects one; clicking the only selected item clears', () => {
    const one = applySelectClick(EMPTY_SELECTION, ids, 'b');
    expect([...one.selected]).toEqual(['b']);
    expect(applySelectClick(one, ids, 'b')).toEqual(EMPTY_SELECTION);
    expect([...applySelectClick(sel('a', 'b'), ids, 'c').selected]).toEqual(['c']);
  });
  it('toggle adds and removes without touching others', () => {
    const s = applySelectClick(sel('a'), ids, 'c', { toggle: true });
    expect([...s.selected]).toEqual(['a', 'c']);
    expect([...applySelectClick(s, ids, 'a', { toggle: true }).selected]).toEqual(['c']);
  });
  it('shift selects the range from the anchor in either direction, keeping the anchor', () => {
    const s = applySelectClick(sel('b'), ids, 'd', { shift: true });
    expect([...s.selected].sort()).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('b');
    const back = applySelectClick(sel('d'), ids, 'b', { shift: true });
    expect([...back.selected].sort()).toEqual(['b', 'c', 'd']);
  });
  it('shift without an anchor behaves as a toggle; unknown ids are ignored', () => {
    expect([...applySelectClick(EMPTY_SELECTION, ids, 'c', { shift: true }).selected]).toEqual([
      'c',
    ]);
    const s = sel('a');
    expect(applySelectClick(s, ids, 'zzz')).toBe(s);
  });
});

describe('helpers', () => {
  it('rangeIds', () => {
    expect(rangeIds(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'a', 'x')).toEqual([]);
  });
  it('toggleSelectAll selects all, then clears', () => {
    const all = toggleSelectAll(sel('a'), ids);
    expect(all.selected.size).toBe(5);
    expect(toggleSelectAll(all, ids)).toEqual(EMPTY_SELECTION);
    expect(toggleSelectAll(EMPTY_SELECTION, [])).toEqual(EMPTY_SELECTION);
  });
  it('pruneSelection drops vanished ids', () => {
    const s = sel('a', 'z');
    const p = pruneSelection(s, ids);
    expect([...p.selected]).toEqual(['a']);
    expect(p.anchor).toBeNull();
    const same = sel('a');
    expect(pruneSelection(same, ids)).toBe(same);
  });
});

describe('moveSelection', () => {
  it('matches a single-item move when the dragged tile is not selected', () => {
    expect(moveSelection(ids, new Set(), 0, 2)).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(moveSelection(ids, new Set(['e']), 3, 1)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });
  it('moves a selection forward as a block after the drop tile, preserving order', () => {
    expect(moveSelection(ids, new Set(['a', 'c']), 0, 3)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });
  it('moves a selection backward before the drop tile', () => {
    expect(moveSelection(ids, new Set(['c', 'e']), 4, 1)).toEqual(['a', 'c', 'e', 'b', 'd']);
  });
  it('dropping onto a selected tile or the end/start works', () => {
    expect(moveSelection(ids, new Set(['b', 'd']), 1, 4)).toEqual(['a', 'c', 'e', 'b', 'd']);
    expect(moveSelection(ids, new Set(['b', 'd']), 3, 0)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });
  it('is a no-op for same or out-of-range indices and never loses ids', () => {
    expect(moveSelection(ids, new Set(['a']), 2, 2)).toEqual(ids);
    expect(moveSelection(ids, new Set(['a']), 2, 9)).toEqual(ids);
    for (let from = 0; from < 5; from++)
      for (let to = 0; to < 5; to++)
        expect(moveSelection(ids, new Set(['b', 'c', 'e']), from, to).sort()).toEqual(ids);
  });
});
