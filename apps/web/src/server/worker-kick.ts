import type { Logger } from '@lumra/observability';

/** Path of the job worker's relay kick (apps/worker `RELAY_KICK_PATH`). */
export const WORKER_RELAY_PATH = '/internal/relay';
/** The kick is best effort: give up quickly, the outbox relay cron is the fallback. */
export const WORKER_KICK_TIMEOUT_MS = 3_000;

export interface WorkerKickConfig {
  workerUrl?: string;
  secret?: string;
  log: Logger;
  requestId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type WorkerKickOutcome = 'skipped' | 'accepted' | 'failed';

/**
 * Asks the job worker to run one outbox relay pass now (`POST {WORKER_URL}/internal/relay`), so
 * a just-committed `media.uploaded` row is published within seconds instead of on the next
 * once-a-minute cron. Never throws: failures are logged at warn and the cron picks the row up.
 * The worker only runs `relayOutbox`, so the outbox stays the single publish path (no duplicates
 * beyond the at-least-once delivery consumers already tolerate).
 */
export async function kickWorkerRelay(config: WorkerKickConfig): Promise<WorkerKickOutcome> {
  const { workerUrl, secret, log } = config;
  if (!workerUrl || !secret) return 'skipped';
  const doFetch = config.fetch ?? fetch;
  try {
    const response = await doFetch(`${workerUrl.replace(/\/$/, '')}${WORKER_RELAY_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        ...(config.requestId ? { 'x-request-id': config.requestId } : {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? WORKER_KICK_TIMEOUT_MS),
      cache: 'no-store',
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 202) {
      log.warn('worker relay kick rejected', { status: response.status });
      return 'failed';
    }
    return 'accepted';
  } catch (err) {
    // Log the error class only: messages can embed the worker URL.
    log.warn('worker relay kick failed', { error: err instanceof Error ? err.name : 'error' });
    return 'failed';
  }
}
