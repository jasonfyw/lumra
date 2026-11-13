import {
  buildMeterEvents,
  MeterExportError,
  type PlanStore,
  type StripeMeterEvent,
  type UsageMetric,
} from '@lumra/billing';
import { STRIPE_API_VERSION, STRIPE_CATALOG_V1 } from '@lumra/config';
import type { MeterExportRepository } from '@lumra/db';
import type { Logger } from '../log';

/**
 * Stripe Billing Meter export (T31, ADR-004 + 2026-11-13 amendment). Thin shell around
 * `buildMeterEvents`:
 *
 * 1. For every paid period (`billing_periods`) of a Stripe customer that is open or closed within
 *    Stripe's 35-day acceptance window, build the cumulative overage delta up to the window end.
 * 2. Store the events and the new cursors in one transaction (`recordExport`), before sending.
 * 3. Send every unsent stored event with `Idempotency-Key` = its `identifier`. A retry resends the
 *    stored payload byte for byte; Stripe dedupes the identifier, so a re-run never double-bills.
 *
 * Runs daily (`17 3 * * *`) for everything and hourly for periods that just closed, so the final
 * usage of a period reaches Stripe while its invoice is still a draft (timestamps are clamped
 * into the period by `buildMeterEvents`).
 */

/** Stripe only accepts meter events up to 35 days old. */
export const METER_EVENT_MAX_AGE_MS = 35 * 86_400_000;
export const MAX_SEND_ATTEMPTS = 20;

export type SendOutcome = { ok: true } | { ok: false; permanent: boolean; error: string };
export type MeterEventSender = (event: StripeMeterEvent) => Promise<SendOutcome>;

/** `POST /v1/billing/meter_events` with the pinned API version; never logs the key. */
export function stripeMeterSender(secretKey: string, fetchImpl: typeof fetch = fetch) {
  return async (event: StripeMeterEvent): Promise<SendOutcome> => {
    const body = new URLSearchParams({
      event_name: event.event_name,
      identifier: event.identifier,
      timestamp: String(event.timestamp),
      'payload[stripe_customer_id]': event.payload.stripe_customer_id,
      'payload[value]': event.payload.value,
    });
    let res: Response;
    try {
      res = await fetchImpl('https://api.stripe.com/v1/billing/meter_events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': STRIPE_API_VERSION,
          'Idempotency-Key': event.identifier,
        },
        body,
      });
    } catch (error) {
      return { ok: false, permanent: false, error: error instanceof Error ? error.name : 'fetch' };
    }
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = json?.error?.code ?? `http_${res.status}`;
    // 4xx other than rate limiting will never succeed with the same body.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    return { ok: false, permanent, error: code };
  };
}

export interface MeterExportDeps {
  repo: MeterExportRepository;
  plans: Pick<PlanStore, 'getRates'>;
  /** Null when `STRIPE_SECRET_KEY` is not configured: nothing is built or sent. */
  send: MeterEventSender | null;
  log: Logger;
  now: () => Date;
  mode: 'daily' | 'period_close';
}

export interface MeterExportResult {
  accounts: number;
  recorded: number;
  conflicts: number;
  failedAccounts: number;
  sent: number;
  sendFailed: number;
  skipped?: 'unconfigured';
}

const HOUR_MS = 3_600_000;

/** Window ends are whole hours, so re-runs within the hour reuse the same identifiers. */
export const exportWindowEnd = (now: Date) =>
  new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);

function eventKey(event: StripeMeterEvent): { metric: UsageMetric; periodStart: Date } {
  // identifier = account:metric:periodStartUnix:windowEndUnix
  const [, metric, periodStart] = event.identifier.split(':');
  return { metric: metric as UsageMetric, periodStart: new Date(Number(periodStart) * 1000) };
}

export async function runMeterExport(deps: MeterExportDeps): Promise<MeterExportResult> {
  const result: MeterExportResult = {
    accounts: 0,
    recorded: 0,
    conflicts: 0,
    failedAccounts: 0,
    sent: 0,
    sendFailed: 0,
  };
  if (!deps.send) return { ...result, skipped: 'unconfigured' };
  const now = deps.now();
  const windowEnd = exportWindowEnd(now);
  const periods = await deps.repo.exportPeriods({
    endedAfter: new Date(now.getTime() - METER_EVENT_MAX_AGE_MS),
    ...(deps.mode === 'period_close'
      ? { closedFrom: new Date(now.getTime() - 3 * HOUR_MS), closedTo: now }
      : {}),
    limit: 10_000,
  });

  const byAccount = new Map<string, typeof periods>();
  for (const p of periods) byAccount.set(p.accountId, [...(byAccount.get(p.accountId) ?? []), p]);

  for (const [accountId, own] of byAccount) {
    result.accounts++;
    try {
      const entries = await deps.repo.ledgerFor(
        accountId,
        own.map((p) => p.periodStart),
        windowEnd,
      );
      if (entries.length === 0) continue;
      const rateVersion = Math.max(...entries.map((e) => e.rateVersion));
      const plan = await deps.plans.getRates('pro', rateVersion);
      const previous = await deps.repo.cursors(accountId);
      const ends = new Map(own.map((p) => [p.periodStart.getTime(), p.periodEnd]));
      const built = buildMeterEvents({
        stripeCustomerId: own[0]!.stripeCustomerId,
        accountId,
        plan,
        windowEnd,
        entries,
        exported: previous,
        periodEndFor: (start) => ends.get(start.getTime()) ?? null,
        catalog: STRIPE_CATALOG_V1,
      });
      if (built.events.length === 0) continue;
      const ok = await deps.repo.recordExport(
        accountId,
        built.events.map((event) => ({ event, ...eventKey(event) })),
        previous,
        built.cursors,
        windowEnd,
      );
      if (ok) result.recorded += built.events.length;
      else result.conflicts++;
    } catch (error) {
      result.failedAccounts++;
      deps.log.error('meter export failed for account', {
        accountId,
        err: error,
        reconcile: error instanceof MeterExportError,
      });
    }
  }

  for (const stored of await deps.repo.unsent(500, MAX_SEND_ATTEMPTS)) {
    const outcome = await deps.send(stored.event);
    if (outcome.ok) {
      await deps.repo.markSent(stored.id);
      result.sent++;
    } else {
      await deps.repo.markFailed(stored.id, outcome.error, outcome.permanent);
      result.sendFailed++;
      deps.log.warn('meter event send failed', {
        accountId: stored.accountId,
        identifier: stored.identifier,
        error: outcome.error,
        permanent: outcome.permanent,
      });
    }
  }
  return result;
}
