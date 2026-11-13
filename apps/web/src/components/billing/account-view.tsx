import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AccountUsageSummary, UsageMeter } from '@lumra/contracts';
import { Tag } from '@/components/ui';
import { formatDate, formatGigabytes, formatUsd } from '@/lib/format';
import { BillingBanners, type CheckoutReturn } from './billing-banners';
import { BillingButton } from './billing-button';
import { InvoiceList } from './invoice-list';
import { SpendingCapForm } from './spending-cap-form';

/**
 * `/account` body (PRD §4, FR-N03, T28–T33): profile, plan + billing actions, usage, invoices and
 * spending cap. Presentational and server-safe; the page (and the dev fixture) pass the summary.
 */

const PLAN_LABEL: Record<AccountUsageSummary['plan'], string> = { free: 'Free', pro: 'Pro' };

const STATUS_LABEL: Partial<Record<AccountUsageSummary['billingStatus'], string>> = {
  past_due: 'Payment past due',
  restricted: 'Restricted',
  canceled: 'Canceled',
};

const section = 'lm-panel flex flex-col gap-4 p-6';
const muted = 'text-sm text-[var(--color-ink-muted)]';

function UsageRow({ label, meter, extra }: { label: string; meter: UsageMeter; extra?: string }) {
  let value: string;
  if (!meter.tracked || meter.usedBytes === null) value = 'Not yet tracked';
  else if (meter.limitBytes === null) value = formatGigabytes(meter.usedBytes);
  else value = `${formatGigabytes(meter.usedBytes)} of ${formatGigabytes(meter.limitBytes)}`;

  return (
    <div className="flex flex-col gap-1">
      <dt className={muted}>{label}</dt>
      <dd className="tabular-nums">
        {value}
        {extra && <span className="text-[var(--color-ink-muted)]"> · {extra}</span>}
      </dd>
      {meter.percentUsed !== null && (
        <dd>
          <progress
            className="h-1.5 w-full max-w-xs accent-[var(--color-accent)]"
            max={100}
            value={meter.percentUsed}
            aria-label={`${label}: ${meter.percentUsed}% of plan limit`}
          />
        </dd>
      )}
    </div>
  );
}

function GalleriesRow({ galleries }: { galleries: AccountUsageSummary['billing']['galleries'] }) {
  const { active, max } = galleries;
  const pct = max ? Math.min(100, Math.round((active / max) * 100)) : null;
  return (
    <div className="flex flex-col gap-1">
      <dt className={muted}>Galleries</dt>
      <dd className="tabular-nums">{max === null ? `${active}` : `${active} of ${max}`}</dd>
      {pct !== null && (
        <dd>
          <progress
            className="h-1.5 w-full max-w-xs accent-[var(--color-accent)]"
            max={100}
            value={pct}
            aria-label={`Galleries: ${active} of ${max} allowed on this plan`}
          />
        </dd>
      )}
    </div>
  );
}

export interface AccountViewProps {
  summary: AccountUsageSummary;
  checkout?: CheckoutReturn;
  /** Pro base fee from the current rate card (`plans`), for the upgrade button. */
  proMonthlyFeeMicroUsd: number;
  /** Overrides for the spending cap / invoices panels (tests). */
  spendingCap?: ReactNode;
  invoices?: ReactNode;
}

export function AccountView({
  summary,
  checkout = null,
  proMonthlyFeeMicroUsd,
  spendingCap,
  invoices,
}: AccountViewProps) {
  const { billing } = summary;
  const items = summary.storage.itemCount;
  const statusLabel = STATUS_LABEL[summary.billingStatus];
  const paid = summary.plan === 'pro';
  const unconfigured = 'Payments aren’t set up on this deployment yet.';

  return (
    <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
      <h1 className="lm-title-1">Account</h1>

      <BillingBanners summary={summary} checkout={checkout} />

      <section aria-labelledby="account-profile" className={section}>
        <h2 id="account-profile" className="text-xl font-semibold">
          Profile
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className={muted}>Email</dt>
            <dd className="break-all">{summary.email ?? 'Unknown'}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={muted}>Plan</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <Tag tone={paid ? 'pro' : 'surface'}>{PLAN_LABEL[summary.plan]}</Tag>
              {statusLabel && (
                <Tag tone="failed" icon="alert">
                  {statusLabel}
                </Tag>
              )}
              <Link href="/pricing" className="text-sm underline underline-offset-4">
                See plans
              </Link>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="account-plan" className={section}>
        <div className="flex flex-col gap-1">
          <h2 id="account-plan" className="text-xl font-semibold">
            Plan
          </h2>
          <p className={muted}>
            {paid
              ? `Pro · ${formatUsd(proMonthlyFeeMicroUsd)}/month plus metered overages. Current period ${formatDate(summary.period.start)} – ${formatDate(summary.period.end)} (UTC).`
              : `Free · ${billing.galleries.max ?? 'unlimited'} galleries, ${formatGigabytes(summary.storage.limitBytes ?? 0)} of photos and ${formatGigabytes(summary.delivery.limitBytes ?? 0)} of delivery a month, with a small Lumra badge on shared galleries.`}
          </p>
        </div>
        {paid || summary.billingStatus === 'canceled' ? (
          <div className="flex flex-wrap gap-3">
            {summary.billingStatus === 'canceled' && (
              <BillingButton
                action="checkout"
                disabled={!billing.paymentsEnabled}
                disabledReason={billing.paymentsEnabled ? undefined : unconfigured}
              >
                Subscribe again · {formatUsd(proMonthlyFeeMicroUsd)}/month
              </BillingButton>
            )}
            <BillingButton
              action="portal"
              variant="secondary"
              disabled={!billing.paymentsEnabled || !billing.hasCustomer}
              disabledReason={billing.paymentsEnabled ? undefined : unconfigured}
            >
              Manage billing
            </BillingButton>
          </div>
        ) : (
          <BillingButton
            action="checkout"
            disabled={!billing.paymentsEnabled}
            disabledReason={billing.paymentsEnabled ? undefined : unconfigured}
          >
            Upgrade to Pro · {formatUsd(proMonthlyFeeMicroUsd)}/month
          </BillingButton>
        )}
      </section>

      <section aria-labelledby="account-usage" className={section}>
        <div className="flex flex-col gap-1">
          <h2 id="account-usage" className="text-xl font-semibold">
            Usage
          </h2>
          <p className={muted}>
            Billing period {formatDate(summary.period.start)} – {formatDate(summary.period.end)}{' '}
            (UTC). Decimal units: 1 GB = 1,000,000,000 bytes.
          </p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <UsageRow
            label="Storage"
            meter={summary.storage}
            extra={`${items} ${items === 1 ? 'photo' : 'photos'}`}
          />
          <UsageRow label="Delivery this period" meter={summary.delivery} />
          <GalleriesRow galleries={billing.galleries} />
        </dl>
      </section>

      <section aria-labelledby="account-billing" className={section}>
        <h2 id="account-billing" className="text-xl font-semibold">
          Billing
        </h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h3 className="font-medium">Invoices</h3>
            {invoices ?? <InvoiceList invoices={summary.invoices} />}
            {billing.hasCustomer && (
              <BillingButton
                action="portal"
                variant="secondary"
                disabled={!billing.paymentsEnabled}
              >
                All invoices and receipts
              </BillingButton>
            )}
          </div>
          <div id="spending-cap" className="flex scroll-mt-6 flex-col gap-3">
            <h3 className="font-medium">Spending cap and alerts</h3>
            {spendingCap ??
              (summary.spend ? (
                <SpendingCapForm spend={summary.spend} />
              ) : (
                <p className={muted}>
                  Free never bills overage: limits are hard caps. On Pro you set a monthly overage
                  cap and get alerts at 50%, 80% and 100% of it.
                </p>
              ))}
          </div>
        </div>
      </section>
    </main>
  );
}
