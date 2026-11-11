/**
 * Static drift checks between the SQL migrations (authoritative) and the TypeScript mirror.
 * Runs in the default `pnpm test` without a database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { RATE_CARD_V1, type PlanRates } from '@lumra/config';
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

  it('has the same set of public tables (PRD §8 + rate_limit_buckets + T27 metering)', () => {
    expect(drizzleTables.map((t) => t.name).sort()).toEqual(Object.keys(fromSql).sort());
    expect(Object.keys(fromSql)).toHaveLength(19);
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

describe('rate card seed (T27)', () => {
  // Column order of the `insert into public.plan_rate_versions (...)` seed in the T27 migration.
  const columns: (keyof PlanRates)[] = [
    'id',
    'rateVersion',
    'monthlyFeeMicroUsd',
    'maxActiveGalleries',
    'maxStorageBytes',
    'maxDeliveryBytesPerMonth',
    'includedStorageGbMonth',
    'includedDeliveryGb',
    'storageOverageMicroUsdPerGbMonth',
    'deliveryOverageMicroUsdPerGb',
    'defaultOverageCapMicroUsd',
    'brandingVisible',
  ];

  function seededRows(table: string): Record<string, unknown>[] {
    const m = new RegExp(`insert into public\\.${table} \\([^)]*\\) values([\\s\\S]*?);`).exec(sql);
    expect(m, `${table} seed`).not.toBeNull();
    // Each row's rate columns are on its first line: `('pro', 1, 2000000, ...`.
    return [...m![1]!.matchAll(/\('(free|pro)',([^\n]*)/g)].map((row) => {
      const values = [row[1]!, ...row[2]!.split(',').map((v) => v.replace(/\)$/, '').trim())];
      const parsed = values.map((v) =>
        v === 'null'
          ? null
          : v === 'true'
            ? true
            : v === 'false'
              ? false
              : /^\d+$/.test(v)
                ? Number(v)
                : v,
      );
      return Object.fromEntries(columns.map((c, i) => [c, parsed[i]]));
    });
  }

  it('plan_rate_versions v1 equals RATE_CARD_V1 exactly (PRD §9.2 proposed defaults)', () => {
    const rows = seededRows('plan_rate_versions');
    expect(rows).toEqual([RATE_CARD_V1.free, RATE_CARD_V1.pro]);
  });

  it('plans are re-projected from their rate version (the core seed predates v1 changes)', () => {
    // The core-schema `plans` seed is historical; the rate-card migration's trigger copies the
    // current version's columns onto each plan, and its `update` re-projects the seeded rows.
    expect(seededRows('plans').map((r) => [r.id, r.rateVersion])).toEqual([
      ['free', RATE_CARD_V1.free.rateVersion],
      ['pro', RATE_CARD_V1.pro.rateVersion],
    ]);
    expect(sql).toMatch(/update public\.plans set rate_version = rate_version;/);
  });
});
