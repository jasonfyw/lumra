import { describe, expect, it } from 'vitest';
import { DB_TIMEOUTS, pgArray, sqlClientOptions } from './client';

describe('sqlClientOptions', () => {
  it('bounds connect/idle time, skips type fetching and sets a statement timeout', () => {
    expect(sqlClientOptions()).toMatchObject({
      max: 5,
      prepare: false,
      connect_timeout: DB_TIMEOUTS.connectSeconds,
      idle_timeout: DB_TIMEOUTS.idleSeconds,
      fetch_types: false,
      connection: { statement_timeout: DB_TIMEOUTS.statementMs },
      debug: false,
    });
    expect(DB_TIMEOUTS.connectSeconds).toBe(5);
  });

  it('omits the startup statement_timeout when disabled (Hyperdrive)', () => {
    const options = sqlClientOptions({ statementTimeoutMs: 0, prepare: true, max: 3 });
    expect(options).not.toHaveProperty('connection');
    expect(options).toMatchObject({ prepare: true, max: 3 });
  });
});

describe('pgArray', () => {
  it('builds a quoted Postgres array literal', () => {
    expect(pgArray([])).toBe('{}');
    expect(pgArray(['a', 'b-1'])).toBe('{"a","b-1"}');
    expect(pgArray(['x"y', 'back\\slash'])).toBe('{"x\\"y","back\\\\slash"}');
  });
});
