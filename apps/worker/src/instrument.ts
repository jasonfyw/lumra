import { withDeadline } from './deadline';

/** Accumulated wall time per step (`db.getForProcessing`, `r2.get`, …), in ms. */
export type StepTimings = Record<string, number>;

type AnyFn = (...args: never[]) => Promise<unknown>;

/**
 * Wraps every async method of `target` so each call is bounded by `ms` (and by `signal`, the
 * job's overall deadline) and its duration is added to `timings[`${prefix}.${method}`]`.
 * Used to put deadlines and step timings around the repositories / R2 bindings / processor that
 * handlers receive, without the handlers knowing about either.
 */
export function bounded<T extends object>(
  target: T,
  prefix: string,
  ms: number,
  options: { signal?: AbortSignal; timings?: StepTimings; now?: () => number } = {},
): T {
  const now = options.now ?? Date.now;
  return new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key) as unknown;
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      const step = `${prefix}.${key}`;
      return (...args: Parameters<AnyFn>) => {
        const started = now();
        const record = () => {
          if (options.timings) {
            options.timings[step] = (options.timings[step] ?? 0) + (now() - started);
          }
        };
        return withDeadline(
          step,
          ms,
          Promise.resolve((value as AnyFn).apply(obj, args)),
          options.signal,
        ).finally(record);
      };
    },
  });
}
