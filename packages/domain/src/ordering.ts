import { ORDERING } from '@lumra/config';

/**
 * Fractional ordering keys for `media.sort_key` (FR-G03, T15).
 *
 * Keys are base-62 strings that sort by plain code-unit comparison (`<` in JS,
 * `COLLATE "C"` in Postgres — never locale collation). A key is an "integer part" whose
 * length is encoded by its head character (`a`–`z` positive, `A`–`Z` negative) followed by
 * an optional fraction without trailing zeros. Appends therefore stay short (`a0`, `a1`, …,
 * `az`, `b00`, …) and inserting between two neighbours never touches other rows.
 *
 * Algorithm after David Greenspan's "Implementing Fractional Indexing" (CC0), ported here so
 * it runs unchanged in Workers and the browser.
 */
export const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ZERO = ORDER_KEY_DIGITS[0] as string;
const LAST = ORDER_KEY_DIGITS[ORDER_KEY_DIGITS.length - 1] as string;
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

export class InvalidOrderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderKeyError';
  }
}

/** Code-unit comparison. Use this (not `localeCompare`) when sorting by `sortKey`. */
export function compareSortKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function digitIndex(char: string | undefined): number {
  const index = char === undefined ? -1 : ORDER_KEY_DIGITS.indexOf(char);
  if (index < 0) throw new InvalidOrderKeyError(`invalid order key digit: ${String(char)}`);
  return index;
}

/** Midpoint of two fractions (`a < b`, `b === null` means 1). Neither may end in zero. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new InvalidOrderKeyError(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) {
    throw new InvalidOrderKeyError('fraction has trailing zero');
  }
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? digitIndex(a[0]) : 0;
  const digitB = b !== null ? digitIndex(b[0]) : ORDER_KEY_DIGITS.length;
  if (digitB - digitA > 1) {
    return ORDER_KEY_DIGITS[Math.round((digitA + digitB) / 2)] as string;
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (ORDER_KEY_DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

function integerLength(head: string | undefined): number {
  if (head !== undefined && head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head !== undefined && head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new InvalidOrderKeyError(`invalid order key head: ${String(head)}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new InvalidOrderKeyError(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function assertValidKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new InvalidOrderKeyError(`invalid order key: ${key}`);
  const int = integerPart(key);
  for (const char of key.slice(1)) digitIndex(char);
  if (key.length > int.length && key.endsWith(ZERO)) {
    throw new InvalidOrderKeyError(`invalid order key: ${key}`);
  }
}

/** True when `key` is a well-formed ordering key. */
export function isValidOrderKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  try {
    assertValidKey(key);
    return true;
  } catch {
    return false;
  }
}

function incrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('') as [string, ...string[]];
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digitIndex(digits[i]) + 1;
    if (next < ORDER_KEY_DIGITS.length) {
      digits[i] = ORDER_KEY_DIGITS[next] as string;
      return head + digits.join('');
    }
    digits[i] = ZERO;
  }
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

function decrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('') as [string, ...string[]];
  for (let i = digits.length - 1; i >= 0; i--) {
    const prev = digitIndex(digits[i]) - 1;
    if (prev >= 0) {
      digits[i] = ORDER_KEY_DIGITS[prev] as string;
      return head + digits.join('');
    }
    digits[i] = LAST;
  }
  if (head === 'a') return `Z${LAST}`;
  if (head === 'A') return null;
  const prevHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prevHead < 'Z') digits.push(LAST);
  else digits.pop();
  return prevHead + digits.join('');
}

/**
 * Returns a key strictly between `a` and `b` (`null` = open end). Deterministic: the same
 * inputs always yield the same key, so concurrent identical inserts must be serialised by the
 * caller (e.g. row lock on the gallery) to avoid duplicate keys.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertValidKey(a);
  if (b !== null) assertValidKey(b);
  if (a !== null && b !== null && a >= b) throw new InvalidOrderKeyError(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint('', fracB);
    if (intB < b) return intB;
    const dec = decrementInteger(intB);
    if (dec === null) throw new InvalidOrderKeyError('cannot decrement any further');
    return dec;
  }

  const intA = integerPart(a);
  const fracA = a.slice(intA.length);
  if (b === null) {
    const inc = incrementInteger(intA);
    return inc === null ? intA + midpoint(fracA, null) : inc;
  }

  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const inc = incrementInteger(intA);
  if (inc === null) throw new InvalidOrderKeyError('cannot increment any further');
  if (inc < b) return inc;
  return intA + midpoint(fracA, null);
}

/** Returns `n` ascending keys strictly between `a` and `b`, e.g. for bulk appends. */
export function nKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid key count: ${n}`);
  if (n === 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const keys: string[] = [];
    let current = a;
    for (let i = 0; i < n; i++) keys.push((current = keyBetween(current, null)));
    return keys;
  }
  if (a === null) {
    const keys: string[] = [];
    let current = b;
    for (let i = 0; i < n; i++) keys.push((current = keyBetween(null, current)));
    return keys.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...nKeysBetween(a, c, mid), c, ...nKeysBetween(c, b, n - mid - 1)];
}

export interface SortableItem {
  id: string;
  sortKey: string;
}

export interface ReorderResult {
  /** Rows whose `sortKey` must change; apply them atomically in one transaction. */
  updates: SortableItem[];
  /** True when keys grew past `maxKeyLength` and every item was re-keyed. */
  rebalanced: boolean;
}

export interface ReorderOptions {
  maxKeyLength?: number;
}

/** Fresh, evenly spread keys for `orderedIds` (also used for a full rebalance). */
export function rebalanceKeys(orderedIds: readonly string[]): SortableItem[] {
  const keys = nKeysBetween(null, null, orderedIds.length);
  return orderedIds.map((id, i) => ({ id, sortKey: keys[i] as string }));
}

/**
 * Computes the minimal set of `sortKey` updates that turns the current order into
 * `orderedIds` (which must be a permutation of the current ids). Items on a longest increasing
 * subsequence of current keys keep their keys; every other item gets a key between its
 * nearest kept neighbours. If any resulting key exceeds `maxKeyLength`, all items are
 * re-keyed instead (`rebalanced: true`). Deterministic for identical input.
 */
export function reorder(
  currentItems: readonly SortableItem[],
  orderedIds: readonly string[],
  options: ReorderOptions = {},
): ReorderResult {
  const maxKeyLength = options.maxKeyLength ?? ORDERING.maxKeyLength;
  const keyById = new Map<string, string>();
  for (const item of currentItems) {
    if (keyById.has(item.id)) throw new InvalidOrderKeyError(`duplicate item id: ${item.id}`);
    keyById.set(item.id, item.sortKey);
  }
  if (orderedIds.length !== keyById.size || new Set(orderedIds).size !== orderedIds.length) {
    throw new InvalidOrderKeyError('orderedIds must be a permutation of the current item ids');
  }
  const keys = orderedIds.map((id) => {
    const key = keyById.get(id);
    if (key === undefined) throw new InvalidOrderKeyError(`unknown item id: ${id}`);
    return key;
  });

  const keep = keysOnLongestIncreasingRun(keys);
  // Invalid legacy keys can't anchor inserts; drop them from the kept set.
  for (let i = 0; i < keys.length; i++) {
    if (keep[i] && !isValidOrderKey(keys[i])) keep[i] = false;
  }

  const updates: SortableItem[] = [];
  let overflow = false;
  let i = 0;
  while (i < orderedIds.length) {
    if (keep[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < orderedIds.length && !keep[end]) end++;
    const lower = i > 0 ? (keys[i - 1] as string) : null;
    const upper = end < keys.length ? (keys[end] as string) : null;
    const fresh = nKeysBetween(lower, upper, end - i);
    for (let j = i; j < end; j++) {
      const sortKey = fresh[j - i] as string;
      if (sortKey.length > maxKeyLength) overflow = true;
      updates.push({ id: orderedIds[j] as string, sortKey });
      keys[j] = sortKey;
    }
    i = end;
  }

  if (!overflow) return { updates, rebalanced: false };
  const rebalancedItems = rebalanceKeys(orderedIds).filter(
    (item) => keyById.get(item.id) !== item.sortKey,
  );
  return { updates: rebalancedItems, rebalanced: true };
}

/** Marks a longest strictly increasing subsequence (O(n log n), deterministic). */
function keysOnLongestIncreasingRun(keys: readonly string[]): boolean[] {
  const tailIndex: number[] = [];
  const previous = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    let lo = 0;
    let hi = tailIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tailIndex[mid] as number] as string) < key) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tailIndex[lo - 1] as number;
    tailIndex[lo] = i;
  }
  const keep = new Array<boolean>(keys.length).fill(false);
  let cursor = tailIndex.length > 0 ? (tailIndex[tailIndex.length - 1] as number) : -1;
  while (cursor >= 0) {
    keep[cursor] = true;
    cursor = previous[cursor] as number;
  }
  return keep;
}
