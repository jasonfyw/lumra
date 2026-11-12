import { describe, expect, it } from 'vitest';
import wranglerText from '../wrangler.jsonc?raw';
import {
  ARCHIVE_SWEEP_CRON,
  DELETION_SWEEP_CRON,
  OUTBOX_RELAY_CRON,
  STORAGE_ACCRUAL_CRON,
  isUsageQueue,
} from './index';

interface Consumer {
  queue: string;
  dead_letter_queue?: string;
}
interface Config {
  limits?: { cpu_ms?: number };
  triggers: { crons: string[] };
  queues: { consumers: Consumer[] };
  env: { production: { queues: { consumers: Consumer[] }; triggers?: unknown } };
}

/** wrangler.jsonc with full-line comments and trailing commas removed. */
function loadConfig(): Config {
  const text = wranglerText.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as Config;
}

describe('wrangler.jsonc (T27 metering bindings)', () => {
  const config = loadConfig();

  it('schedules the outbox relay and the storage accrual crons (inherited by production)', () => {
    expect(config.triggers.crons).toContain(OUTBOX_RELAY_CRON);
    expect(config.triggers.crons).toContain(STORAGE_ACCRUAL_CRON);
    expect(config.triggers.crons).toContain(DELETION_SWEEP_CRON);
    expect(config.triggers.crons).toContain(ARCHIVE_SWEEP_CRON);
    expect(config.env.production.triggers).toBeUndefined();
  });

  it('allows archive builds the maximum CPU per invocation (T24, ADR-003)', () => {
    expect(config.limits?.cpu_ms).toBe(300_000);
    expect((config.env.production as { limits?: unknown }).limits).toBeUndefined();
  });

  it('consumes the media gateway usage queue with a DLQ in every environment', () => {
    for (const consumers of [config.queues.consumers, config.env.production.queues.consumers]) {
      const usage = consumers.filter((c) => isUsageQueue(c.queue));
      expect(usage).toHaveLength(1);
      expect(usage[0]!.dead_letter_queue).toMatch(/^lumra-usage-dlq/);
    }
    expect(config.env.production.queues.consumers.map((c) => c.queue)).toContain('lumra-usage');
  });
});
