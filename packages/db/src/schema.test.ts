/**
 * Static drift checks between the SQL migrations (authoritative) and the TypeScript mirror.
 * Runs in the default `pnpm test` without a database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { DB_ENUMS } from './enums';
import * as schema from './schema';

const migrationsDir = join(import.meta.dirname, '../../../infra/supabase/migrations');
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
  .join('\n')
  // strip line comments
  .replace(/--[^\n]*/g, '');

function sqlEnums(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of sql.matchAll(/create type public\.(\w+) as enum \(([^)]*)\)/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!);
  }
  return out;
}

function sqlTables(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const m of sql.matchAll(/create table public\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const cols = new Set<string>();
    for (const line of m[2]!.split('\n')) {
      const col = /^ {2}([a-z_][a-z0-9_]*) /.exec(line)?.[1];
      if (col && col !== 'constraint') cols.add(col);
    }
    out[m[1]!] = cols;
  }
  // Later migrations add columns with `alter table public.x add column y ...`.
  for (const m of sql.matchAll(
    /alter table public\.(\w+)\s+add column (?:if not exists )?(\w+)/g,
  )) {
    out[m[1]!]?.add(m[2]!);
  }
  return out;
}

const drizzleTables = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t))
  .filter((c) => (c.schema ?? 'public') === 'public');

describe('SQL enums match TypeScript status sets', () => {
  const fromSql = sqlEnums();
  it('defines exactly the enums declared in DB_ENUMS', () => {
    expect(Object.keys(fromSql).sort()).toEqual(Object.keys(DB_ENUMS).sort());
  });
  for (const [name, values] of Object.entries(DB_ENUMS)) {
    it(`${name} values and order match`, () => {
      expect(fromSql[name]).toEqual([...values]);
    });
  }
});

describe('Drizzle schema mirrors SQL tables', () => {
  const fromSql = sqlTables();

  it('has the same set of public tables (PRD §8 tables + rate_limit_buckets)', () => {
    expect(drizzleTables.map((t) => t.name).sort()).toEqual(Object.keys(fromSql).sort());
    expect(Object.keys(fromSql)).toHaveLength(17);
  });

  for (const table of drizzleTables) {
    it(`${table.name} has identical columns`, () => {
      expect(table.columns.map((c) => c.name).sort()).toEqual(
        [...(fromSql[table.name] ?? [])].sort(),
      );
    });
  }
});

describe('RLS coverage', () => {
  it('enables row level security on every public table', () => {
    const enabled = new Set(
      [...sql.matchAll(/alter table public\.(\w+) enable row level security/g)].map((m) => m[1]),
    );
    for (const table of Object.keys(sqlTables())) expect(enabled, table).toContain(table);
  });
});
