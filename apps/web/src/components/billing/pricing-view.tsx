import Link from 'next/link';
import { rateInvoice, spendCapToleranceMicroUsd, storageGbMonthMicroUnits } from '@lumra/billing';
import { BILLING_POLICY_V1, BYTES_PER_GB, type BillingPolicy, type PlanRates } from '@lumra/config';
import { Icon, Tag, buttonClass } from '@/components/ui';
import { formatGigabytes, formatUsd, formatUsdRate } from '@/lib/format';
import { BillingButton } from './billing-button';

/**
 * `/pricing` (PRD §4, §9): Free and Pro limits, overage rates, the worked example and the rate
 * definitions — every number comes from the rate card passed in (the `plans` table at runtime),
 * and the example is rated by `@lumra/billing`, so the page can never disagree with invoices.
 */

export type PricingViewer =
  { kind: 'anonymous' } | { kind: 'free'; paymentsEnabled: boolean } | { kind: 'pro' };

const DAY_MS = 86_400_000;

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon name="check" size={18} className="mt-0.5 shrink-0 text-[var(--color-ink-muted)]" />
      <span>{children}</span>
    </li>
  );
}

/** PRD §9.3 example: 30 GB-month stored on Pro. Delivery is free (ADR-008). */
export function workedExample(pro: PlanRates, policy: BillingPolicy = BILLING_POLICY_V1) {
  const storedGbMonth = 30;
  const byteSeconds =
    BigInt(storedGbMonth) * BigInt(BYTES_PER_GB) * BigInt(policy.secondsPerBillingMonth);
  const invoice = rateInvoice({
    plan: pro,
    storageGbMonthMicro: storageGbMonthMicroUnits(byteSeconds, policy.secondsPerBillingMonth),
    rateVersion: pro.rateVersion,
  });
  return { storedGbMonth, invoice };
}

export function PricingView({
  free,
  pro,
  viewer,
  checkout = null,
  policy = BILLING_POLICY_V1,
}: {
  free: PlanRates;
  pro: PlanRates;
  viewer: PricingViewer;
  checkout?: 'canceled' | null;
  policy?: BillingPolicy;
}) {
  const example = workedExample(pro, policy);
  const line = (kind: string) => example.invoice.lines.find((l) => l.kind === kind);
  const cap = pro.defaultOverageCapMicroUsd;
  const card = 'lm-panel flex flex-col gap-5 p-6';

  return (
    <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-10 px-4 py-8 sm:px-8 sm:py-12">
      <header className="flex max-w-2xl flex-col gap-3">
        <h1 className="lm-title-1">Pricing</h1>
        <p className="lm-body-lg text-[var(--color-ink-muted)]">
          Start free. Pro is {formatUsd(pro.monthlyFeeMicroUsd)} a month with a generous allowance,
          and you only pay for storage above it — with a spending cap you control. Viewing and
          downloading your galleries is never metered or charged.
        </p>
      </header>

      {checkout === 'canceled' && (
        <p role="status" className="lm-banner">
          Checkout was canceled. Nothing was charged.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="plan-free" className={card}>
          <div className="flex flex-col gap-1">
            <h2 id="plan-free" className="text-xl font-semibold">
              Free
            </h2>
            <p className="lm-title-2 tabular-nums">
              $0{' '}
              <span className="text-base font-normal text-[var(--color-ink-muted)]">forever</span>
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            <Feature>{free.maxActiveGalleries ?? 'Unlimited'} active galleries</Feature>
            <Feature>{formatGigabytes(free.maxStorageBytes ?? 0)} of photos in total</Feature>
            <Feature>Views and downloads included, not metered</Feature>
            <Feature>No card needed, never billed</Feature>
            <Feature>A small “Made with Lumra” badge on shared galleries</Feature>
          </ul>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Limits are hard caps: when one is reached, new uploads or galleries are refused — you
            are never charged. Shared galleries stay online.
          </p>
          <div className="mt-auto">
            <Link href="/new" className={buttonClass('secondary', 'md', 'min-h-11')}>
              Create a gallery
            </Link>
          </div>
        </section>

        <section aria-labelledby="plan-pro" className={`${card} border-[var(--color-ink)]`}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 id="plan-pro" className="text-xl font-semibold">
                Pro
              </h2>
              <Tag tone="pro">Pro</Tag>
            </div>
            <p className="lm-title-2 tabular-nums">
              {formatUsd(pro.monthlyFeeMicroUsd)}{' '}
              <span className="text-base font-normal text-[var(--color-ink-muted)]">/ month</span>
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            <Feature>Unlimited galleries (fair use)</Feature>
            <Feature>{pro.includedStorageGbMonth} GB-month of storage included</Feature>
            <Feature>
              Then {formatUsdRate(pro.storageOverageMicroUsdPerGbMonth ?? 0)} per GB-month
            </Feature>
            <Feature>Views and downloads included, not metered</Feature>
            {cap !== null && (
              <Feature>
                Spending cap of {formatUsd(cap)} in overages by default, adjustable, with alerts at{' '}
                {policy.defaultAlertThresholdsPct.join('%, ').replace(/, (\d+)$/, ' and $1')}%
              </Feature>
            )}
            <Feature>No Lumra badge</Feature>
          </ul>
          <div className="mt-auto">
            {viewer.kind === 'anonymous' && (
              <Link
                href="/auth?returnTo=%2Fpricing"
                className={buttonClass('primary', 'md', 'min-h-11')}
              >
                Sign in to upgrade
              </Link>
            )}
            {viewer.kind === 'free' && (
              <BillingButton
                action="checkout"
                disabled={!viewer.paymentsEnabled}
                disabledReason={
                  viewer.paymentsEnabled
                    ? undefined
                    : 'Payments aren’t set up on this deployment yet.'
                }
              >
                Upgrade to Pro
              </BillingButton>
            )}
            {viewer.kind === 'pro' && (
              <Link href="/account" className={buttonClass('secondary', 'md', 'min-h-11')}>
                You’re on Pro · Manage billing
              </Link>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="pricing-example" className="lm-panel flex flex-col gap-4 p-6">
        <h2 id="pricing-example" className="text-xl font-semibold">
          Example month on Pro
        </h2>
        <p className="text-[var(--color-ink-muted)]">{example.storedGbMonth} GB-month stored:</p>
        <table className="w-full max-w-lg border-collapse text-left tabular-nums">
          <tbody>
            <tr className="border-b border-[var(--color-hairline)]">
              <th scope="row" className="py-2 font-normal">
                Base subscription
              </th>
              <td className="py-2 text-right">
                {formatUsd(line('base_fee')?.amountMicroUsd ?? 0)}
              </td>
            </tr>
            <tr className="border-b border-[var(--color-hairline)]">
              <th scope="row" className="py-2 font-normal">
                Storage: ({example.storedGbMonth} − {pro.includedStorageGbMonth}) GB-month ×{' '}
                {formatUsdRate(pro.storageOverageMicroUsdPerGbMonth ?? 0)}
              </th>
              <td className="py-2 text-right">
                {formatUsd(line('storage_overage')?.amountMicroUsd ?? 0)}
              </td>
            </tr>
            <tr>
              <th scope="row" className="py-2 font-semibold">
                Total before tax
              </th>
              <td className="py-2 text-right font-semibold">
                {formatUsd(example.invoice.totalMicroUsd)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section aria-labelledby="pricing-definitions" className="flex max-w-3xl flex-col gap-3">
        <h2 id="pricing-definitions" className="text-xl font-semibold">
          How usage is measured
        </h2>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">Gigabyte</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Decimal: 1 GB = 1,000,000,000 bytes. Storage counts your originals plus the optimised
              copies Lumra generates.
            </dd>
          </div>
          <div>
            <dt className="font-medium">GB-month</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Storage averaged over time: 1 GB kept for a {policy.secondsPerBillingMonth / 86_400}
              -day month. 20 GB kept for half a month is 10 GB-month.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Views and downloads</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Not metered and not charged on any plan: previews, full-size views and downloads are
              included.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Spending cap</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Covers storage overage. Uploads that would take your projected overage past the cap
              are refused; shared galleries stay online. Usage readings lag slightly, so the final
              overage can exceed the cap by at most{' '}
              {cap !== null ? formatUsd(spendCapToleranceMicroUsd(cap, policy)) : 'a small amount'}{' '}
              ({policy.spendCapToleranceBps / 100}% of the cap, at least{' '}
              {formatUsd(policy.spendCapToleranceMinMicroUsd)}).
            </dd>
          </div>
          <div>
            <dt className="font-medium">Failed payments</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Uploads pause right away; shared galleries stay online for{' '}
              {Math.round(policy.pastDueGraceMs / DAY_MS)} days, then go offline. Your photos are
              kept for {Math.round(policy.retentionAfterSuspensionMs / DAY_MS)} more days.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Taxes and cancellation</dt>
            <dd className="text-[var(--color-ink-muted)]">
              Prices are in US dollars, before any applicable tax. Cancel any time from the billing
              portal; Pro stays active until the end of the paid period.
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
