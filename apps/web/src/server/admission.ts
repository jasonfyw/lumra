import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { BILLING_POLICY_V1 } from '@lumra/config';
import {
  checkAdmission,
  currentBillingPeriod,
  estimateStoredFootprintBytes,
  type AdmissionDecision,
  type Reservation,
} from '@lumra/billing';
import { billingAccounts, planRatesFromRow, plans, profiles } from '@lumra/db';
import type { Tx } from '@/lib/db';

/**
 * Plan admission for an account (FR-G07, PRD §9.4, T28; archives T24). Runs inside the caller's
 * transaction and locks the billing account row, so concurrent uploads / archive requests for
 * one account are admitted one at a time against the same totals.
 *
 * Inputs: stored bytes (committed originals with the conservative derivative estimate,
 * `estimateStoredFootprintBytes`), this period's storage ledger total, and pending reservations —
 * live upload intents. Archives are not billed (ADR-008): they are only gated by billing status.
 */
export async function evaluateAccountAdmission(
  tx: Tx,
  userId: string,
  requested: Reservation,
  now: Date,
): Promise<AdmissionDecision> {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.userId, userId))
    .for('update');
  const [profile] = await tx
    .select({ planId: profiles.planId })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  const [planRow] = await tx
    .select()
    .from(plans)
    .where(eq(plans.id, profile?.planId ?? 'free'));
  if (!planRow) throw new Error('plan row missing');
  const plan = planRatesFromRow(planRow);

  const period = currentBillingPeriod(account, now);

  // Committed = objects that exist (or existed and are not yet removed); pending = live intents.
  const [usage] = await tx.execute<{
    committed_bytes: string;
    committed_items: string;
    pending_bytes: string;
    pending_items: string;
  }>(sql`
    select
      coalesce(sum(m.byte_size) filter (where committed), 0)::text as committed_bytes,
      count(*) filter (where committed)::text as committed_items,
      coalesce(sum(m.byte_size) filter (where pending), 0)::text as pending_bytes,
      count(*) filter (where pending)::text as pending_items
    from (
      select m.byte_size,
        (m.status in ('uploaded', 'processing', 'ready')
          or (m.status in ('failed', 'deleting') and us.status = 'completed')) as committed,
        (m.status in ('reserved', 'uploading') and us.status = 'pending'
          and us.expires_at > now()) as pending
      from public.media m
      join public.galleries g on g.id = m.gallery_id
      left join public.upload_sessions us on us.id = m.upload_session_id
      where g.owner_id = ${userId}::uuid and m.status <> 'deleted'
    ) m`);
  const [ledger] = await tx.execute<{ byte_seconds: string }>(sql`
    select
      coalesce(sum(quantity_micro_units) filter (where metric = 'storage_byte_seconds'), 0)::text
        as byte_seconds
    from public.usage_ledger
    where account_id = ${userId}::uuid and period_start = ${period.start.toISOString()}::timestamptz`);

  return checkAdmission({
    plan,
    account: {
      status: account?.status ?? 'free',
      pastDueSince: account?.pastDueSince ?? null,
      restrictedSince: account?.restrictedSince ?? null,
      canceledAt: account?.canceledAt ?? null,
    },
    now,
    period,
    currentUsage: {
      storedBytes: estimateStoredFootprintBytes({
        originalBytes: Number(usage?.committed_bytes ?? 0),
        items: Number(usage?.committed_items ?? 0),
      }),
      storageByteSecondsToDate: BigInt(ledger?.byte_seconds ?? '0'),
    },
    reservations: [
      {
        kind: 'upload',
        bytes: estimateStoredFootprintBytes({
          originalBytes: Number(usage?.pending_bytes ?? 0),
          items: Number(usage?.pending_items ?? 0),
        }),
      },
    ],
    requested,
    capMicroUsd: account?.spendCapMicroUsd ?? null,
    policy: BILLING_POLICY_V1,
  });
}
