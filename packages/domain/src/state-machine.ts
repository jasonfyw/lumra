/** Minimal transition-table helper so every state machine is declared as data and testable. */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition<S extends string>(
  machine: string,
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(table, from, to)) throw new InvalidTransitionError(machine, from, to);
}
