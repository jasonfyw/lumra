import { defaultRedactor, type Redactor } from './redact';

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: SerializedError;
}

export interface SerializeErrorOptions {
  /** Include the (redacted) stack. Callers enable this only at debug level outside production. */
  includeStack?: boolean;
  redactor?: Redactor;
}

const SAFE_NAME = /^[A-Za-z_$][A-Za-z0-9_.$]{0,63}$/;
const MAX_MESSAGE = 500;
const MAX_CAUSE_DEPTH = 3;

/**
 * Serializes a thrown value for logs without leaking internals: only `name`, a redacted and
 * length-capped `message`, a primitive `code`, a bounded `cause` chain and — only when asked —
 * a redacted stack. Arbitrary enumerable properties (which may hold queries, rows or
 * credentials) are never copied.
 */
export function serializeError(
  error: unknown,
  options: SerializeErrorOptions = {},
): SerializedError {
  return serialize(error, options, 0);
}

function serialize(error: unknown, options: SerializeErrorOptions, depth: number): SerializedError {
  const { redactString } = options.redactor ?? defaultRedactor;
  const clip = (s: string) => {
    const r = redactString(s);
    return r.length > MAX_MESSAGE ? `${r.slice(0, MAX_MESSAGE)}…` : r;
  };

  if (!(error instanceof Error)) {
    if (typeof error === 'string') return { name: 'NonError', message: clip(error) };
    const message = (error as { message?: unknown } | null)?.message;
    return {
      name: 'NonError',
      message:
        typeof message === 'string'
          ? clip(message)
          : `thrown ${error === null ? 'null' : typeof error}`,
    };
  }

  const out: SerializedError = {
    name: SAFE_NAME.test(error.name) ? error.name : 'Error',
    message: clip(error.message),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' || (typeof code === 'string' && code.length <= 64)) {
    out.code = typeof code === 'string' ? redactString(code) : code;
  }
  if (options.includeStack && typeof error.stack === 'string') {
    out.stack = redactString(error.stack);
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serialize(error.cause, options, depth + 1);
  }
  return out;
}
