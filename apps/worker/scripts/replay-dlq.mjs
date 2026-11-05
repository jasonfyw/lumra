#!/usr/bin/env node
// Replays dead-lettered jobs back onto the main jobs queue (PRD §6.3 manual replay, T12).
// Runbook: docs/RUNBOOKS.md → "Queue backlog / dead-letter queue".
//
// Prerequisites (once per environment): the DLQ needs an HTTP pull consumer
//   pnpm --filter @lumra/worker exec wrangler queues consumer http add lumra-jobs-dlq-<env>
// and an API token with "Queues Edit" for the account.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//   node apps/worker/scripts/replay-dlq.mjs --from lumra-jobs-dlq-dev --to lumra-jobs-dev \
//     [--type media.uploaded] [--limit 100] [--dry-run]
//
// Without --dry-run, each pulled message is re-sent to --to and then acked on the DLQ, so a
// crash in between re-delivers it (consumers are idempotent via dedupeKey). Messages filtered
// out by --type, and with --dry-run all messages, are released (retried) back onto the DLQ
// rather than acked, so nothing is lost. Message bodies are never printed: only id, type and
// attempts (bodies may contain IDs that are fine to log, but keep the habit).

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    type: { type: 'string' },
    limit: { type: 'string', default: '100' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!args.from || !args.to || !accountId || !token) {
  console.error(
    'usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… replay-dlq.mjs --from <dlq> --to <queue> [--type t] [--limit n] [--dry-run]',
  );
  process.exit(2);
}
const limit = Math.max(1, Number.parseInt(args.limit, 10) || 100);
const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`;

async function cf(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(
      `Cloudflare API ${res.status} on ${path}: ${JSON.stringify(json.errors ?? [])}`,
    );
  }
  return json.result;
}

async function queueId(name) {
  const queues = await cf('?per_page=100');
  const match = queues.find((q) => q.queue_name === name);
  if (!match) throw new Error(`queue not found: ${name}`);
  return match.queue_id;
}

function decodeBody(message) {
  // HTTP pull returns JSON-typed messages as a JSON string.
  if (typeof message.body !== 'string') return message.body;
  try {
    return JSON.parse(message.body);
  } catch {
    return null;
  }
}

const dlq = await queueId(args.from);
const target = await queueId(args.to);
let replayed = 0;
let released = 0;
let skippedInvalid = 0;

while (replayed + released < limit) {
  const batchSize = Math.min(100, limit - replayed - released);
  const pulled = await cf(`/${dlq}/messages/pull`, {
    method: 'POST',
    body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: 60_000 }),
  });
  const messages = pulled?.messages ?? [];
  if (messages.length === 0) break;

  const toSend = [];
  const acks = [];
  const retries = [];
  for (const message of messages) {
    const body = decodeBody(message);
    const valid =
      body &&
      typeof body === 'object' &&
      typeof body.type === 'string' &&
      typeof body.dedupeKey === 'string';
    if (!valid) {
      // Undecodable: leave it on the DLQ for manual inspection.
      skippedInvalid++;
      retries.push({ lease_id: message.lease_id });
      continue;
    }
    const selected = !args.type || body.type === args.type;
    console.info(
      JSON.stringify({
        id: message.id,
        type: body.type,
        attempts: message.attempts,
        action: selected && !args['dry-run'] ? 'replay' : 'keep',
      }),
    );
    if (selected && !args['dry-run']) {
      toSend.push({ body, content_type: 'json' });
      acks.push({ lease_id: message.lease_id });
    } else {
      retries.push({ lease_id: message.lease_id });
    }
  }

  if (toSend.length > 0) {
    await cf(`/${target}/messages/batch`, {
      method: 'POST',
      body: JSON.stringify({ messages: toSend }),
    });
    replayed += toSend.length;
  }
  released += retries.length;
  await cf(`/${dlq}/messages/ack`, { method: 'POST', body: JSON.stringify({ acks, retries }) });
  if (retries.length === messages.length) break; // nothing left that we are allowed to take
}

console.info(
  JSON.stringify({ replayed, kept: released, invalid: skippedInvalid, dryRun: args['dry-run'] }),
);
