import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import {
  applySubscriptionSnapshot,
  effectiveCapMicroUsd,
  fitsFreeCaps,
  reconcileInvoice,
  type EntitlementState,
  type SubscriptionSnapshot,
} from '@lumra/billing';
import { RATE_CARD_V1, type PlanId } from '@lumra/config';
import {
  billingAccounts,
  billingInvoices,
  billingReconciliations,
  plans,
  planRatesFromRow,
  planRateVersions,
  profiles,
  type Database,
} from '@lumra/db';
import type { Logger } from '@lumra/observability';
import type { Tx } from '@/lib/db';
import { accountFootprint, enqueueAccountEmail, enqueueOwnerAccessSync } from './billing-state';
import { stripeId } from './stripe';

/**
 * Stripe webhook processing (T29/T30/T33, PRD §9.5, G-06).
 *
 * Each verified event is handled in ONE transaction that first claims the event id in
 * `provider_webhook_events` (UNIQUE provider + event id), then applies its effect, then marks it
 * handled. A replay finds the row `processed`/`ignored` and does nothing; two concurrent
 * deliveries serialise on the row lock and the second becomes the replay. A failure rolls
 * everything back (the claim included) and answers 500, so Stripe retries; the attempt is then
 * recorded on its own (`failed`) for operators.
 *
 * Entitlements come only from `customer.subscription.*` payloads — the confirmed state — through
 * `applySubscriptionSnapshot`. Checkout completion merely links the customer. Side effects go
 * through the outbox inside the same transaction (KV access re-sync, `email.send`).
 */

/** Events Lumra acts on (subscribe the endpoint to exactly these; docs/BILLING.md). */
export const HANDLED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  // T31: invoice history + reconciliation.
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
] as const;

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate';

export interface WebhookResult {
  outcome: WebhookOutcome;
  accountId: string | null;
  /** A committed entitlement change: re-apply the delivery cutoff after the transaction. */
  reevaluate: boolean;
  /** Why an event was ignored (logged; never payload data). */
  reason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function objectIdOf(event: Stripe.Event): string | null {
  const object = event.data.object as { id?: unknown };
  return typeof object.id === 'string' ? object.id.slice(0, 255) : null;
}

/** The subscription fields the entitlement rules read (periods live on items since 2025-03). */
export function subscriptionSnapshot(
  subscription: Stripe.Subscription,
  eventCreatedSeconds: number,
): SubscriptionSnapshot {
  const items = subscription.items?.data ?? [];
  const starts = items.map((i) => i.current_period_start).filter((v) => Number.isFinite(v));
  const ends = items.map((i) => i.current_period_end).filter((v) => Number.isFinite(v));
  return {
    subscriptionId: subscription.id,
    customerId: stripeId(subscription.customer) ?? '',
    status: subscription.status,
    periodStart: starts.length ? new Date(Math.min(...starts) * 1000) : null,
    periodEnd: ends.length ? new Date(Math.max(...ends) * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end || subscription.cancel_at !== null,
    eventCreated: new Date(eventCreatedSeconds * 1000),
  };
}

async function claimEvent(tx: Tx, event: Stripe.Event): Promise<string | null> {
  const [row] = (await tx.execute<{ id: string }>(sql`
    insert into public.provider_webhook_events
      (provider, provider_event_id, event_type, object_id, attempt_count)
    values ('stripe', ${event.id}, ${event.type.slice(0, 100)}, ${objectIdOf(event)}, 1)
    on conflict on constraint provider_webhook_events_provider_event_key do update
      set attempt_count = public.provider_webhook_events.attempt_count + 1
      where public.provider_webhook_events.status not in ('processed', 'ignored')
    returning id`)) as unknown as { id: string }[];
  return row?.id ?? null;
}

async function finishEvent(
  tx: Tx,
  id: string,
  outcome: 'processed' | 'ignored',
  accountId: string | null,
) {
  await tx.execute(sql`
    update public.provider_webhook_events
    set status = ${outcome}::public.webhook_event_status, handled_at = now(), last_error = null,
        account_id = ${accountId}::uuid
    where id = ${id}::uuid`);
}

/** Best-effort record of a failed attempt (after the rollback); Stripe will retry the event. */
export async function recordFailedEvent(db: Database, event: Stripe.Event, error: unknown) {
  const errorClass = (error instanceof Error ? error.name : 'unknown').slice(0, 200);
  await db
    .execute(
      sql`
      insert into public.provider_webhook_events
        (provider, provider_event_id, event_type, object_id, status, attempt_count, last_error)
      values ('stripe', ${event.id}, ${event.type.slice(0, 100)}, ${objectIdOf(event)},
              'failed', 1, ${errorClass})
      on conflict on constraint provider_webhook_events_provider_event_key do update
        set status = 'failed', last_error = excluded.last_error,
            attempt_count = public.provider_webhook_events.attempt_count + 1
        where public.provider_webhook_events.status not in ('processed', 'ignored')`,
    )
    .catch(() => undefined);
}

type Applied = {
  outcome: 'processed' | 'ignored';
  accountId: string | null;
  reevaluate: boolean;
  reason?: string;
};

export async function handleStripeEvent(
  db: Database,
  event: Stripe.Event,
  options: { log: Logger },
): Promise<WebhookResult> {
  return db.transaction(async (tx): Promise<WebhookResult> => {
    const claimId = await claimEvent(tx, event);
    if (!claimId) return { outcome: 'duplicate', accountId: null, reevaluate: false };
    const applied = await applyEvent(tx, event, options.log);
    await finishEvent(tx, claimId, applied.outcome, applied.accountId);
    return applied;
  });
}

async function applyEvent(tx: Tx, event: Stripe.Event, log: Logger): Promise<Applied> {
  switch (event.type) {
    case 'checkout.session.completed':
      return linkCheckoutCustomer(tx, event.data.object);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySubscription(tx, event, subscriptionSnapshot(event.data.object, event.created), {
        metadataUserId: event.data.object.metadata?.lumra_user_id ?? null,
        log,
      });
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      return applyInvoice(tx, event, event.data.object, log);
    default:
      return { outcome: 'ignored', accountId: null, reevaluate: false, reason: 'unhandled_type' };
  }
}

/** Links the Stripe customer to the account (usually already linked at checkout creation). */
async function linkCheckoutCustomer(tx: Tx, session: Stripe.Checkout.Session): Promise<Applied> {
  const userId = session.client_reference_id;
  const customer = stripeId(session.customer);
  if (session.mode !== 'subscription' || !userId || !UUID.test(userId) || !customer) {
    return { outcome: 'ignored', accountId: null, reevaluate: false, reason: 'not_lumra_checkout' };
  }
  const [row] = await tx
    .update(billingAccounts)
    .set({ stripeCustomerId: customer })
    .where(and(eq(billingAccounts.userId, userId), isNull(billingAccounts.stripeCustomerId)))
    .returning({ userId: billingAccounts.userId });
  return { outcome: 'processed', accountId: row?.userId ?? userId, reevaluate: false };
}

async function freePlanCaps(tx: Tx) {
  const [row] = await tx.select().from(plans).where(eq(plans.id, 'free'));
  return row ? planRatesFromRow(row) : RATE_CARD_V1.free;
}

/**
 * Maps a confirmed subscription onto its account (by customer id; the `lumra_user_id` metadata
 * set at checkout is the fallback for a customer not linked yet), locks the row and applies
 * `applySubscriptionSnapshot`.
 */
async function applySubscription(
  tx: Tx,
  event: Stripe.Event,
  snapshot: SubscriptionSnapshot,
  options: { metadataUserId: string | null; log: Logger },
): Promise<Applied> {
  const byCustomer = eq(billingAccounts.stripeCustomerId, snapshot.customerId);
  const byMetadata =
    options.metadataUserId && UUID.test(options.metadataUserId)
      ? and(
          eq(billingAccounts.userId, options.metadataUserId),
          isNull(billingAccounts.stripeCustomerId),
        )
      : undefined;
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(byMetadata ? or(byCustomer, byMetadata) : byCustomer)
    .orderBy(sql`(${billingAccounts.stripeCustomerId} is null)`)
    .limit(1)
    .for('update');
  if (!account) {
    options.log.warn('stripe subscription for unknown customer', {
      eventId: event.id,
      type: event.type,
    });
    return { outcome: 'ignored', accountId: null, reevaluate: false, reason: 'unknown_customer' };
  }
  const userId = account.userId;
  const [profile] = await tx
    .select({ planId: profiles.planId })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');

  const current: EntitlementState = {
    status: account.status,
    planId: (profile?.planId ?? 'free') as PlanId,
    stripeSubscriptionId: account.stripeSubscriptionId,
    stripeSubscriptionStatus: account.stripeSubscriptionStatus,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    billingPeriodStart: account.billingPeriodStart,
    billingPeriodEnd: account.billingPeriodEnd,
    pastDueSince: account.pastDueSince,
    restrictedSince: account.restrictedSince,
    canceledAt: account.canceledAt,
    subscriptionEventAt: account.subscriptionEventAt,
  };
  const decision = applySubscriptionSnapshot(current, snapshot, {
    fitsFreeCaps: fitsFreeCaps(await freePlanCaps(tx), await accountFootprint(tx, userId)),
  });
  if (decision.kind === 'ignore') {
    options.log.info('stripe subscription event ignored', {
      eventId: event.id,
      accountId: userId,
      reason: decision.reason,
    });
    return { outcome: 'ignored', accountId: userId, reevaluate: false, reason: decision.reason };
  }

  const next = decision.next;
  await tx
    .update(billingAccounts)
    .set({
      stripeCustomerId: account.stripeCustomerId ?? snapshot.customerId,
      stripeSubscriptionId: next.stripeSubscriptionId,
      stripeSubscriptionStatus: next.stripeSubscriptionStatus,
      status: next.status,
      cancelAtPeriodEnd: next.cancelAtPeriodEnd,
      billingPeriodStart: next.billingPeriodStart,
      billingPeriodEnd: next.billingPeriodEnd,
      pastDueSince: next.pastDueSince,
      restrictedSince: next.restrictedSince,
      canceledAt: next.canceledAt,
      subscriptionEventAt: next.subscriptionEventAt,
    })
    .where(eq(billingAccounts.userId, userId));
  if (
    (next.status === 'active' || next.status === 'past_due' || next.status === 'restricted') &&
    next.billingPeriodStart &&
    next.billingPeriodEnd &&
    next.stripeSubscriptionId
  ) {
    // Paid periods: the only periods whose usage the meter export may send (T31).
    await tx.execute(sql`
      insert into public.billing_periods (account_id, period_start, period_end, stripe_subscription_id)
      values (${userId}::uuid, ${next.billingPeriodStart.toISOString()}::timestamptz,
              ${next.billingPeriodEnd.toISOString()}::timestamptz, ${next.stripeSubscriptionId})
      on conflict (account_id, period_start) do update
        set period_end = excluded.period_end,
            stripe_subscription_id = excluded.stripe_subscription_id`);
  }
  if (next.planId !== current.planId) {
    // Plan drives limits (gallery/storage caps, overage) and branding ("Made with Lumra").
    await tx.update(profiles).set({ planId: next.planId }).where(eq(profiles.userId, userId));
  }
  const traceId = `stripe:${event.id}`;
  if (decision.accessChanged) await enqueueOwnerAccessSync(tx, userId, traceId);
  for (const notice of decision.notices) {
    await enqueueAccountEmail(
      tx,
      userId,
      { template: notice, dedupeKey: `email:${notice}:${userId}:${event.id}` },
      traceId,
    );
  }
  options.log.info('billing account updated from stripe', {
    eventId: event.id,
    accountId: userId,
    from: current.status,
    to: next.status,
    plan: next.planId,
  });
  return { outcome: 'processed', accountId: userId, reevaluate: true };
}

// ---------------------------------------------------------------------------------------------
// invoices (T31): history for /account + reconciliation against the internal ledger
// ---------------------------------------------------------------------------------------------

const INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);
const toDate = (seconds: number | null | undefined) =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
const httpsOrNull = (url: string | null | undefined) =>
  url && url.startsWith('https://') ? url : null;

async function applyInvoice(
  tx: Tx,
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  log: Logger,
): Promise<Applied> {
  const customer = stripeId(invoice.customer);
  const [account] = customer
    ? await tx
        .select({ userId: billingAccounts.userId, spendCap: billingAccounts.spendCapMicroUsd })
        .from(billingAccounts)
        .where(eq(billingAccounts.stripeCustomerId, customer))
    : [];
  if (!account || !invoice.id) {
    return { outcome: 'ignored', accountId: null, reevaluate: false, reason: 'unknown_customer' };
  }
  const status = INVOICE_STATUSES.has(invoice.status ?? '') ? invoice.status! : 'draft';
  const eventAt = new Date(event.created * 1000);
  const values = {
    accountId: account.userId,
    stripeInvoiceId: invoice.id,
    number: invoice.number,
    status: status as 'draft' | 'open' | 'paid' | 'uncollectible' | 'void',
    billingReason: invoice.billing_reason,
    currency: invoice.currency,
    subtotalCents: invoice.subtotal,
    totalCents: invoice.total,
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    periodStart: toDate(invoice.period_start),
    periodEnd: toDate(invoice.period_end),
    hostedInvoiceUrl: httpsOrNull(invoice.hosted_invoice_url),
    invoicePdf: httpsOrNull(invoice.invoice_pdf),
    stripeCreatedAt: new Date(invoice.created * 1000),
    stripeEventAt: eventAt,
  };
  // Newer state wins; an older redelivery never rolls the status back.
  await tx
    .insert(billingInvoices)
    .values(values)
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: { ...values, accountId: undefined, stripeInvoiceId: undefined },
      setWhere: sql`${billingInvoices.stripeEventAt} <= ${eventAt.toISOString()}::timestamptz`,
    });

  if (event.type === 'invoice.finalized' && invoice.billing_reason !== 'manual') {
    await reconcile(tx, account, invoice, log);
  }
  return { outcome: 'processed', accountId: account.userId, reevaluate: false };
}

/**
 * Internal vs Stripe for a finalized subscription invoice (PRD §9.5): renewal invoices carry the
 * new period's base fee plus the ended period's metered overage; the first invoice the base fee.
 * The usage period is the invoice's `period_start` (the ledger rows' period stamp).
 */
async function reconcile(
  tx: Tx,
  account: { userId: string; spendCap: number | null },
  invoice: Stripe.Invoice,
  log: Logger,
) {
  const firstInvoice = invoice.billing_reason === 'subscription_create';
  const usagePeriod = toDate(invoice.period_start);
  const [usage] = (await tx.execute<{
    byte_seconds: string;
    delivery: string;
    version: number | null;
  }>(sql`
    select
      coalesce(sum(quantity_micro_units) filter (where metric = 'storage_byte_seconds'), 0)::text
        as byte_seconds,
      coalesce(sum(quantity_micro_units) filter (where metric = 'delivery_bytes'), 0)::text
        as delivery,
      max(rating_version) as version
    from public.usage_ledger
    where account_id = ${account.userId}::uuid
      and period_start = ${usagePeriod?.toISOString() ?? null}::timestamptz`)) as unknown as {
    byte_seconds: string;
    delivery: string;
    version: number | null;
  }[];
  const [current] = await tx.select().from(plans).where(eq(plans.id, 'pro'));
  let plan = current ? planRatesFromRow(current) : RATE_CARD_V1.pro;
  if (usage?.version && usage.version !== plan.rateVersion) {
    const [versioned] = await tx
      .select()
      .from(planRateVersions)
      .where(
        and(eq(planRateVersions.planId, 'pro'), eq(planRateVersions.rateVersion, usage.version)),
      );
    if (versioned) plan = planRatesFromRow(versioned);
  }
  const byteSeconds = BigInt(usage?.byte_seconds ?? '0');
  const result = reconcileInvoice({
    plan,
    usage: {
      storageByteSeconds: byteSeconds < 0n ? 0n : byteSeconds,
      deliveryBytes: Math.max(0, Number(usage?.delivery ?? 0)),
    },
    stripeSubtotalCents: invoice.subtotal,
    firstInvoice,
    capMicroUsd: effectiveCapMicroUsd(plan, account.spendCap),
  });
  const row = {
    accountId: account.userId,
    stripeInvoiceId: invoice.id!,
    usagePeriodStart: firstInvoice ? null : usagePeriod,
    expectedCents: result.expectedCents,
    stripeCents: result.stripeCents,
    driftBps: result.driftBps,
    flagged: result.flagged,
    exceedsCapTolerance: result.exceedsCapTolerance,
  };
  await tx
    .insert(billingReconciliations)
    .values(row)
    .onConflictDoUpdate({ target: billingReconciliations.stripeInvoiceId, set: row });
  if (result.flagged || result.exceedsCapTolerance) {
    // Operator alert (RUNBOOKS: billed vs internal drift). Ids and amounts only.
    log.error('billing reconciliation mismatch', {
      accountId: account.userId,
      invoiceId: invoice.id,
      expectedCents: result.expectedCents,
      stripeCents: result.stripeCents,
      driftBps: result.driftBps,
      exceedsCapTolerance: result.exceedsCapTolerance,
    });
  }
}
