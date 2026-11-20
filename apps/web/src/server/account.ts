import 'server-only';
import { sql } from 'drizzle-orm';
import {
  currentBillingPeriod,
  deriveBillingRestrictions,
  effectiveCapMicroUsd,
  estimateOverageMicroUsd,
  planBillsOverage,
  summarizeUsage,
  type BillingRestrictions,
} from '@lumra/billing';
import { BILLING_POLICY_V1 } from '@lumra/config';
import type { AccountInvoice, AccountSpend, AccountUsageSummary } from '@lumra/contracts';
import { billingInvoices, planRatesFromRow, plans, type Database } from '@lumra/db';
import { desc, eq } from 'drizzle-orm';

/**
 * Account page / `GET /api/v1/billing/usage` (PRD §4, FR-N03). Read-only. The caller has already
 * authenticated the user; every query is scoped to `userId`, so no other account's rows are read.
 * Figures come from data that exists today:
 *  - storage: bytes of stored originals plus generated derivatives in non-deleted galleries
 *    (the same definition as the dashboard's per-gallery size). Delivery is not tracked (ADR-008).
 * Rules (period, limits, percentages) live in `@lumra/billing`.
 */

interface AccountRow extends Record<string, unknown> {
  email: string | null;
  plan_id: 'free' | 'pro' | null;
  max_storage_bytes: string | null;
  status: AccountUsageSummary['billingStatus'] | null;
  billing_period_start: Date | string | null;
  billing_period_end: Date | string | null;
  max_active_galleries: number | null;
  has_customer: boolean | null;
  cancel_at_period_end: boolean | null;
  past_due_since: Date | string | null;
  restricted_since: Date | string | null;
  canceled_at: Date | string | null;
  active_galleries: number;
  spend_cap_micro_usd: string | null;
  warning_thresholds: string | null;
}

interface StorageRow extends Record<string, unknown> {
  item_count: string;
  original_bytes: string;
  variant_bytes: string;
}

const toDate = (v: Date | string | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);
const toBytes = (v: string | null): number | null => (v === null ? null : Number(v));

/** Restrictions for display; a row violating its own invariants reads as fully restricted. */
function restrictionsFor(
  status: AccountUsageSummary['billingStatus'],
  row: AccountRow | undefined,
  now: Date,
): BillingRestrictions {
  try {
    return deriveBillingRestrictions(
      {
        status,
        pastDueSince: toDate(row?.past_due_since ?? null),
        restrictedSince: toDate(row?.restricted_since ?? null),
        canceledAt: toDate(row?.canceled_at ?? null),
      },
      now,
    );
  } catch {
    return {
      effectiveStatus: status,
      uploadsAllowed: false,
      archivesAllowed: false,
      publicDeliveryAllowed: false,
      deliverySuspendsAt: null,
      retentionEndsAt: null,
      reasons: [],
    };
  }
}

export async function getAccountUsageSummary(
  db: Database,
  user: { userId: string; email: string | null },
  now = new Date(),
  options: { paymentsEnabled?: boolean } = {},
): Promise<AccountUsageSummary> {
  const { userId } = user;

  // Plan limits come from the `plans` row (authoritative copy of the rate card).
  const [account] = (await db.execute<AccountRow>(sql`
    select p.email, p.plan_id,
           pl.max_storage_bytes::text as max_storage_bytes,
           ba.status, ba.billing_period_start, ba.billing_period_end,
           pl.max_active_galleries,
           ba.stripe_customer_id is not null as has_customer, ba.cancel_at_period_end,
           ba.past_due_since, ba.restricted_since, ba.canceled_at,
           ba.spend_cap_micro_usd::text as spend_cap_micro_usd,
           array_to_string(ba.warning_thresholds, ',') as warning_thresholds,
           (select count(*)::int from public.galleries g
             where g.owner_id = u.user_id and g.deleted_at is null) as active_galleries
    from (select ${userId}::uuid as user_id) u
    left join public.profiles p on p.user_id = u.user_id
    left join public.plans pl on pl.id = coalesce(p.plan_id, 'free')
    left join public.billing_accounts ba on ba.user_id = u.user_id
  `)) as unknown as AccountRow[];

  const period = currentBillingPeriod(
    {
      billingPeriodStart: toDate(account?.billing_period_start ?? null),
      billingPeriodEnd: toDate(account?.billing_period_end ?? null),
    },
    now,
  );

  const [storage] = (await db.execute<StorageRow>(sql`
    select count(*)::text as item_count,
           coalesce(sum(m.byte_size), 0)::text as original_bytes,
           coalesce((
             select sum(mv.byte_size)
             from public.media_variants mv
             join public.media mm on mm.id = mv.media_id
             join public.galleries gg on gg.id = mm.gallery_id
             where gg.owner_id = ${userId}::uuid and gg.deleted_at is null
               and mm.deleted_at is null
           ), 0)::text as variant_bytes
    from public.media m
    join public.galleries g on g.id = m.gallery_id
    where g.owner_id = ${userId}::uuid and g.deleted_at is null and m.deleted_at is null
      and m.status in ('uploaded', 'processing', 'ready')
  `)) as unknown as StorageRow[];

  const storedBytes = Number(storage?.original_bytes ?? 0) + Number(storage?.variant_bytes ?? 0);

  const usage = summarizeUsage({
    plan: { maxStorageBytes: toBytes(account?.max_storage_bytes ?? null) },
    storedBytes,
  });

  const spend = await spendSummary(db, userId, account, period.start);
  const invoices = await recentInvoices(db, userId);
  const billingStatus = account?.status ?? 'free';
  const restrictions = restrictionsFor(billingStatus, account, now);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  return {
    email: user.email ?? account?.email ?? null,
    plan: account?.plan_id ?? 'free',
    billingStatus,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    storage: { ...usage.storage, itemCount: Number(storage?.item_count ?? 0) },
    billing: {
      paymentsEnabled: options.paymentsEnabled ?? false,
      hasCustomer: account?.has_customer === true,
      cancelAtPeriodEnd: account?.cancel_at_period_end === true,
      uploadsAllowed: restrictions.uploadsAllowed,
      publicDeliveryAllowed: restrictions.publicDeliveryAllowed,
      deliverySuspendsAt: iso(restrictions.deliverySuspendsAt),
      retentionEndsAt: iso(restrictions.retentionEndsAt),
      galleries: {
        active: Number(account?.active_galleries ?? 0),
        max: account?.max_active_galleries ?? null,
      },
    },
    spend,
    invoices,
  };
}

/**
 * Pro spending cap, estimated overage and alerts this period (T32). Uses the same rating as
 * admission and the alert runner (`estimateOverageMicroUsd`) on the internal storage ledger.
 */
async function spendSummary(
  db: Database,
  userId: string,
  account: AccountRow | undefined,
  periodStart: Date,
): Promise<AccountSpend | null> {
  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.id, account?.plan_id ?? 'free'));
  if (!planRow) return null;
  const plan = planRatesFromRow(planRow);
  if (!planBillsOverage(plan) || plan.defaultOverageCapMicroUsd === null) return null;
  const custom = account?.spend_cap_micro_usd != null;
  const cap = effectiveCapMicroUsd(plan, custom ? Number(account!.spend_cap_micro_usd) : null)!;
  const [usage] = (await db.execute<{
    byte_seconds: string;
    alerts: string | null;
  }>(sql`
    select
      coalesce(sum(quantity_micro_units) filter (where metric = 'storage_byte_seconds'), 0)::text
        as byte_seconds,
      (select string_agg(a.threshold_pct::text, ',' order by a.threshold_pct)
         from public.billing_alerts a
         where a.account_id = ${userId}::uuid
           and a.period_start = ${periodStart.toISOString()}::timestamptz) as alerts
    from public.usage_ledger
    where account_id = ${userId}::uuid
      and period_start = ${periodStart.toISOString()}::timestamptz`)) as unknown as {
    byte_seconds: string;
    alerts: string | null;
  }[];
  const estimated = estimateOverageMicroUsd(
    {
      storageByteSeconds:
        BigInt(usage?.byte_seconds ?? '0') < 0n ? 0n : BigInt(usage?.byte_seconds ?? '0'),
    },
    plan,
  );
  const percent =
    cap === 0 ? (estimated > 0 ? 100 : 0) : Math.min(100, Math.floor((estimated * 100) / cap));
  const thresholds = account?.warning_thresholds
    ? account.warning_thresholds.split(',').map(Number)
    : [...BILLING_POLICY_V1.defaultAlertThresholdsPct];
  return {
    capMicroUsd: cap,
    custom,
    defaultCapMicroUsd: plan.defaultOverageCapMicroUsd,
    maxCapMicroUsd: BILLING_POLICY_V1.maxSpendCapMicroUsd,
    estimatedOverageMicroUsd: estimated,
    percentOfCap: percent,
    alertsReached: usage?.alerts ? usage.alerts.split(',').map(Number) : [],
    thresholdsPct: thresholds,
  };
}

/** Webhook-stored invoices (T31), newest first; drafts are not shown. */
async function recentInvoices(db: Database, userId: string): Promise<AccountInvoice[]> {
  const rows = await db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.accountId, userId))
    .orderBy(desc(billingInvoices.stripeCreatedAt))
    .limit(13);
  return rows
    .filter((r) => r.status !== 'draft')
    .slice(0, 12)
    .map((r) => ({
      id: r.stripeInvoiceId,
      number: r.number,
      status: r.status,
      currency: r.currency,
      totalCents: r.totalCents,
      amountDueCents: r.amountDueCents,
      createdAt: r.stripeCreatedAt.toISOString(),
      periodStart: r.periodStart?.toISOString() ?? null,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      hostedInvoiceUrl: r.hostedInvoiceUrl,
      invoicePdf: r.invoicePdf,
    }));
}
