import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel, type LogLevel } from './logger';

function capture(options: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = createLogger({
    service: 'test',
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    sink: (line, level) => lines.push({ line, level }),
    ...options,
  });
  const events = () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>);
  return { logger, lines, events };
}

describe('createLogger', () => {
  it('emits one JSON line with standard fields first', () => {
    const { logger, lines, events } = capture();
    logger.info('hello', { requestId: 'req-1', traceId: 'tr-1', galleryId: 'g1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.line.includes('\n')).toBe(false);
    expect(Object.keys(events()[0]!)).toEqual([
      'ts',
      'level',
      'service',
      'msg',
      'requestId',
      'traceId',
      'galleryId',
    ]);
    expect(events()[0]).toEqual({
      ts: '2026-11-05T00:00:00.000Z',
      level: 'info',
      service: 'test',
      msg: 'hello',
      requestId: 'req-1',
      traceId: 'tr-1',
      galleryId: 'g1',
    });
  });

  it('omits requestId/traceId when absent', () => {
    const { logger, events } = capture();
    logger.warn('w');
    expect(events()[0]).toEqual({
      ts: '2026-11-05T00:00:00.000Z',
      level: 'warn',
      service: 'test',
      msg: 'w',
    });
  });

  it('filters below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('falls back to info for unknown levels', () => {
    expect(createLogger({ service: 's', level: 'verbose' }).level).toBe('info');
    expect(parseLogLevel(' DEBUG ')).toBe('debug');
    expect(parseLogLevel(undefined, 'warn')).toBe('warn');
  });

  it('merges base and child fields; event fields win; reserved keys cannot be overridden', () => {
    const { logger, events } = capture({ base: { region: 'iad' } });
    const child = logger.child({ requestId: 'req-9', route: 'GET /x' });
    child.info('done', {
      route: 'GET /y',
      level: 'error',
      service: 'evil',
      ts: 'never',
      msg: 'spoof',
    });
    expect(events()[0]).toEqual({
      ts: '2026-11-05T00:00:00.000Z',
      level: 'info',
      service: 'test',
      msg: 'done',
      requestId: 'req-9',
      region: 'iad',
      route: 'GET /y',
    });
  });

  it('serializes errors without stacks by default', () => {
    const { logger, events } = capture();
    logger.error('failed', {
      err: Object.assign(new Error('boom'), { code: 'E1', sql: 'select 1' }),
    });
    expect(events()[0]?.err).toEqual({ name: 'Error', message: 'boom', code: 'E1' });
  });

  it('includes redacted stacks only at debug outside production', () => {
    const dev = capture({ level: 'debug' });
    dev.logger.error('failed', { error: new Error('boom') });
    expect(typeof (dev.events()[0]?.error as { stack?: unknown }).stack).toBe('string');

    const prod = capture({ level: 'debug', production: true });
    prod.logger.error('failed', { error: new Error('boom') });
    expect((prod.events()[0]?.error as { stack?: unknown }).stack).toBeUndefined();
  });

  it('never throws on unserializable input or a failing sink', () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const { logger, events } = capture();
    expect(() => logger.info('x', { circ, n: 1n })).not.toThrow();
    expect(events()[0]?.circ).toEqual({ self: '[Circular]' });

    const throwing = createLogger({
      service: 's',
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => throwing.error('x')).not.toThrow();
  });

  it('routes levels to the matching console method by default', () => {
    const calls: string[] = [];
    const original = { info: console.info, warn: console.warn, error: console.error };
    console.info = () => calls.push('info');
    console.warn = () => calls.push('warn');
    console.error = () => calls.push('error');
    try {
      const logger = createLogger({ service: 's', level: 'debug' });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
    } finally {
      Object.assign(console, original);
    }
    expect(calls).toEqual(['info', 'info', 'warn', 'error']);
  });
});
