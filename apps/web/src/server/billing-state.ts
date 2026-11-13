import 'server-only';
import { sql } from 'drizzle-orm';
import { evaluateBillingSafeguards, type SafeguardResult } from '@lumra/billing';
import { createBillingStateRepository, type Database } from '@lumra/db';
import type { Logger } from '@lumra/observability';
import type { Tx } from '@/lib/db';

/**
 * Billing-state writes shared by the webhook (T29/T30) and the spending-cap endpoint (T32).
 * Rules come from `@lumra/billing`; persistence of the delivery cutoff reuses the worker's
 * Postgres adapter (`createBillingStateRepository`) so web and worker flip the pause identically.
 */

/** Non-deleted galleries and stored bytes (originals + derivatives), as `/account` counts them. */
export async function accountFootprint(
  tx: Tx | Database,
  userId: string,
): Promise<{ activeGalleries: number; storedBytes: number }> {
  const [row] = (await tx.execute<{ galleries: number; bytes: string }>(sql`
    select
      (select count(*)::int from public.galleries g
        where g.owner_id = ${userId}::uuid and g.deleted_at is null) as galleries,
      (
        coalesce((
          select sum(m.byte_size) from public.media m
          join public.galleries g on g.id = m.gallery_id
          where g.owner_id = ${userId}::uuid and g.deleted_at is null
            and m.deleted_at is null and m.status in ('uploaded', 'processing', 'ready')
        ), 0)
        + coalesce((
          select sum(mv.byte_size) from public.media_variants mv
          join public.media m on m.id = mv.media_id
          join public.galleries g on g.id = m.gallery_id
          where g.owner_id = ${userId}::uuid and g.deleted_at is null and m.deleted_at is null
        ), 0)
      )::text as bytes`)) as unknown as { galleries: number; bytes: string }[];
  return { activeGalleries: Number(row?.galleries ?? 0), storedBytes: Number(row?.bytes ?? 0) };
}

/** Re-sync every published gallery's KV access state for `userId` (status/plan/pause changed). */
export async function enqueueOwnerAccessSync(tx: Tx, userId: string, traceId: string) {
  await tx.execute(sql`select public.enqueue_owner_access_sync(${userId}::uuid, ${traceId})`);
}

/** Once-only account email through the outbox (`email.send`); false when already enqueued. */
export async function enqueueAccountEmail(
  tx: Tx,
  userId: string,
  notice: { template: string; dedupeKey: string; data?: Record<string, string | number> },
  traceId: string,
): Promise<boolean> {
  const [row] = (await tx.execute<{ inserted: boolean }>(sql`
    select public.enqueue_account_email(${userId}::uuid, ${notice.template}, ${notice.dedupeKey},
      ${JSON.stringify(notice.data ?? {})}::jsonb, ${traceId}) as inserted`)) as unknown as {
    inserted: boolean;
  }[];
  return row?.inserted === true;
}

/**
 * Re-applies the delivery safety cutoff after a committed plan / status / cap change (an
 * upgrade lifts a Free-cap pause at once; a lower cap pauses at once). Best effort: the worker
 * re-evaluates on every delivery batch and hourly, so a failure here only delays convergence.
 */
export async function reevaluateDeliveryPause(
  db: Database,
  userId: string,
  options: { now?: Date; traceId: string; log: Logger },
): Promise<SafeguardResult | null> {
  try {
    const result = await evaluateBillingSafeguards([userId], {
      store: createBillingStateRepository(db.$client),
      now: options.now ?? new Date(),
      traceId: options.traceId,
    });
    for (const change of result.changes) {
      options.log.info(change.paused ? 'delivery paused' : 'delivery resumed', {
        accountId: change.accountId,
        ...(change.paused ? { reason: change.paused } : {}),
      });
    }
    return result;
  } catch (error) {
    options.log.warn('delivery cutoff re-evaluation failed', { err: error });
    return null;
  }
}
