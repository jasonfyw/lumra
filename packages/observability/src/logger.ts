import { serializeError } from './errors';
import { defaultRedactor, type Redactor } from './redact';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

/** Receives one serialized JSON line per event. */
export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger whose events all carry `fields` (e.g. `{ requestId }`). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Emitting runtime: `web`, `media-gateway`, `worker`. */
  service: string;
  /** Minimum level; unknown strings fall back to `info`. */
  level?: LogLevel | string;
  /** Fields attached to every event. */
  base?: LogFields;
  /** In production, error stacks are never logged regardless of level. */
  production?: boolean;
  sink?: LogSink;
  redactor?: Redactor;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'service', 'msg']);
const ERROR_KEYS = new Set(['err', 'error', 'cause']);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown, fallback: LogLevel = 'info'): LogLevel {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return isLogLevel(v) ? v : fallback;
}

/** Default sink: one line per event on the console, which Vercel and Workers Logs ingest. */
export const consoleSink: LogSink = (line, level) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

/**
 * Structured JSON logger. Each event is one line:
 * `{"ts","level","service","msg","requestId"?,"traceId"?, ...fields}`; all fields pass
 * through redaction, and `err`/`error` values are serialized with `serializeError`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = parseLogLevel(options.level);
  const sink = options.sink ?? consoleSink;
  const redactor = options.redactor ?? defaultRedactor;
  const now = options.now ?? (() => new Date());
  const includeStack = level === 'debug' && !options.production;

  function build(base: LogFields): Logger {
    function emit(eventLevel: LogLevel, msg: string, fields?: LogFields) {
      if (RANK[eventLevel] < RANK[level]) return;
      const merged: LogFields = { ...base, ...fields };
      for (const key of ERROR_KEYS) {
        if (merged[key] instanceof Error) {
          merged[key] = serializeError(merged[key], { includeStack, redactor });
        }
      }
      const clean = (redactor.redact(merged) ?? {}) as LogFields;
      const { requestId, traceId, ...rest } = clean;
      const event: LogFields = {
        ts: now().toISOString(),
        level: eventLevel,
        service: options.service,
        msg: redactor.redactString(String(msg)),
      };
      if (requestId !== undefined) event.requestId = requestId;
      if (traceId !== undefined) event.traceId = traceId;
      for (const [key, value] of Object.entries(rest)) {
        if (!RESERVED.has(key)) event[key] = value;
      }
      let line: string;
      try {
        line = JSON.stringify(event);
      } catch {
        line = JSON.stringify({
          ts: event.ts,
          level: eventLevel,
          service: options.service,
          msg: event.msg,
        });
      }
      try {
        sink(line, eventLevel);
      } catch {
        // Logging must never take down a request.
      }
    }

    return {
      level,
      debug: (msg, fields) => emit('debug', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      error: (msg, fields) => emit('error', msg, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  }

  return build({ ...options.base });
}
