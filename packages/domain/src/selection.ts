/**
 * Pure multi-select and group-reorder logic for the owner gallery editor. Operates on ordered
 * lists of media ids so it runs (and is tested) without any UI.
 */

export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  /** Last item clicked without shift; the fixed end of a shift-click range. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export interface SelectClick {
  /** Extend from the anchor to the clicked item. */
  shift?: boolean;
  /** Cmd/Ctrl-click or the checkbox: toggle just this item. */
  toggle?: boolean;
}

/** Ids between `a` and `b` inclusive, in list order; empty if either is missing. */
export function rangeIds(orderedIds: readonly string[], a: string, b: string): string[] {
  const i = orderedIds.indexOf(a);
  const j = orderedIds.indexOf(b);
  if (i < 0 || j < 0) return [];
  return orderedIds.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * Next selection after a click on `id`. Shift adds the anchor..id range (keeping the anchor);
 * toggle flips one item; a plain click selects only that item (or clears it if it was the only
 * one selected).
 */
export function applySelectClick(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
  click: SelectClick = {},
): SelectionState {
  if (!orderedIds.includes(id)) return state;
  if (click.shift && state.anchor && orderedIds.includes(state.anchor)) {
    const next = new Set(state.selected);
    for (const r of rangeIds(orderedIds, state.anchor, id)) next.add(r);
    return { selected: next, anchor: state.anchor };
  }
  if (click.toggle || click.shift) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  if (state.selected.size === 1 && state.selected.has(id)) return EMPTY_SELECTION;
  return { selected: new Set([id]), anchor: id };
}

/** Select every id (or clear when everything is already selected). */
export function toggleSelectAll(
  state: SelectionState,
  orderedIds: readonly string[],
): SelectionState {
  const all = orderedIds.length > 0 && orderedIds.every((id) => state.selected.has(id));
  return all ? EMPTY_SELECTION : { selected: new Set(orderedIds), anchor: state.anchor };
}

/** Drops ids that no longer exist (e.g. after a delete or refresh). Returns `state` if unchanged. */
export function pruneSelection(
  state: SelectionState,
  orderedIds: readonly string[],
): SelectionState {
  const valid = new Set(orderedIds);
  const kept = [...state.selected].filter((id) => valid.has(id));
  const anchor = state.anchor && valid.has(state.anchor) ? state.anchor : null;
  if (kept.length === state.selected.size && anchor === state.anchor) return state;
  return { selected: new Set(kept), anchor };
}

/**
 * Order after dragging the tile at `from` onto the tile at index `to` (indices into
 * `orderedIds`). If the dragged tile is selected the whole selection moves as one block,
 * keeping its internal order; otherwise only the dragged tile moves. Moving forward puts the
 * block after the drop tile, moving backward before it, which matches a single-item move.
 */
export function moveSelection(
  orderedIds: readonly string[],
  selected: ReadonlySet<string>,
  from: number,
  to: number,
): string[] {
  const dragged = orderedIds[from];
  if (dragged === undefined || to < 0 || to >= orderedIds.length || from === to) {
    return [...orderedIds];
  }
  const group = selected.has(dragged) ? selected : new Set([dragged]);
  const block = orderedIds.filter((id) => group.has(id));
  const rest = orderedIds.filter((id) => !group.has(id));
  const upTo = to > from ? to + 1 : to;
  const insertAt = orderedIds.slice(0, upTo).filter((id) => !group.has(id)).length;
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}
