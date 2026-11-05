export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Structured JSON logs. Never pass tokens, signed URLs, filenames or object bytes. */
export const log: Logger = (level, msg, fields = {}) => {
  const sink = { info: console.info, warn: console.warn, error: console.error }[level];
  sink(JSON.stringify({ level, msg, service: 'worker', ...fields }));
};
