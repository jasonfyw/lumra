#!/usr/bin/env node
/**
 * Applies the auth email templates in infra/supabase/templates to a HOSTED Supabase project
 * (the local stack reads them from infra/supabase/config.toml on `supabase start`).
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/supabase-apply-email-templates.mjs [--dry-run]
 *       [--project-ref <ref>]
 *
 * Subjects and template files come from the `[auth.email.template.*]` tables of
 * infra/supabase/config.toml, so local dev and hosted stay in step. It PATCHes
 * https://api.supabase.com/v1/projects/{ref}/config/auth with `mailer_subjects_*` and
 * `mailer_templates_*_content`, and only the fields that differ from the live config.
 *
 * `--dry-run` changes nothing. With a token it reads the live config and prints which fields would
 * change; without one it lists the fields it would send. The token is never printed, and neither
 * are template bodies (field names and sizes only). Dependency-free; needs Node 20+.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.supabase.com/v1';
const DEFAULT_PROJECT_REF = 'mwhqpzzrjkxrlxjzfnow';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'infra/supabase/config.toml');

/** `[auth.email.template.<name>]` tables: `{ name: { subject, contentPath } }`. */
export function parseTemplateTables(toml) {
  const tables = {};
  let current = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const header = /^\[auth\.email\.template\.([a-z_]+)\]$/.exec(line);
    if (header) {
      current = tables[header[1]] = {};
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const kv = current && /^(subject|content_path)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (kv) current[kv[1] === 'subject' ? 'subject' : 'contentPath'] = kv[2];
  }
  return tables;
}

/** Management API fields to send, from the config tables. */
export async function buildFields(toml = null) {
  const text = toml ?? (await readFile(configPath, 'utf8'));
  const fields = {};
  for (const [name, t] of Object.entries(parseTemplateTables(text))) {
    if (!t.subject || !t.contentPath) continue;
    // content_path is relative to the Supabase workdir (infra/).
    const body = await readFile(resolve(root, 'infra', t.contentPath), 'utf8');
    fields[`mailer_subjects_${name}`] = t.subject;
    fields[`mailer_templates_${name}_content`] = body;
  }
  return fields;
}

function describe(value) {
  return typeof value === 'string' && value.length > 80
    ? `${value.length} bytes`
    : JSON.stringify(value);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const refIndex = args.indexOf('--project-ref');
  const ref =
    (refIndex >= 0 ? args[refIndex + 1] : null) ??
    process.env.SUPABASE_PROJECT_REF ??
    DEFAULT_PROJECT_REF;
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('invalid project ref');
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token && !dryRun)
    throw new Error('SUPABASE_ACCESS_TOKEN is required (use --dry-run to preview)');

  const fields = await buildFields();
  if (Object.keys(fields).length === 0) throw new Error('no templates found in config.toml');
  const url = `${API}/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let live = null;
  if (token) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`reading the live auth config failed (HTTP ${res.status})`);
    live = await res.json();
  }

  const changed = Object.entries(fields).filter(([key, value]) => !live || live[key] !== value);
  for (const [key, value] of Object.entries(fields)) {
    const state = !live
      ? 'would send'
      : changed.some(([k]) => k === key)
        ? 'would change'
        : 'unchanged';
    console.log(`${state.padEnd(12)} ${key} (${describe(value)})`);
  }
  if (dryRun) {
    console.log(`dry run: nothing sent to project ${ref}`);
    return;
  }
  if (changed.length === 0) {
    console.log(`project ${ref}: templates already up to date`);
    return;
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(Object.fromEntries(changed)),
  });
  if (!res.ok) throw new Error(`PATCH failed (HTTP ${res.status})`);
  console.log(`project ${ref}: updated ${changed.length} field(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
