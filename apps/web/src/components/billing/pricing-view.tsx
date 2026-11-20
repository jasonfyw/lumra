import Link from 'next/link';
import { rateInvoice, spendCapToleranceMicroUsd, storageGbMonthMicroUnits } from '@lumra/billing';
import { BILLING_POLICY_V1, BYTES_PER_GB, type BillingPolicy, type PlanRates } from '@lumra/config';
import { Icon, type IconName, buttonClass } from '@/components/ui';
import { formatGigabytes, formatUsd, formatUsdRate } from '@/lib/format';
import { BillingButton } from './billing-button';

/**
 * `/pricing` (PRD §4, §9): a visual Free/Pro comparison, a cost bar for the worked example and a
 * compact FAQ — every number comes from the rate card passed in (the `plans` table at runtime),
 * and the example is rated by `@lumra/billing`, so the page can never disagree with invoices.
 */

export type PricingViewer =
  { kind: 'anonymous' } | { kind: 'free'; paymentsEnabled: boolean } | { kind: 'pro' };

const DAY_MS = 86_400_000;

function Feature({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-sunken)]">
        <Icon name={icon} size={16} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-[var(--color-hairline)] py-1">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
        {q}
        <Icon
          name="chevron-down"
          size={18}
          className="shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <p className="pb-3 text-[var(--color-ink-muted)]">{children}</p>
    </details>
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
  const rate = formatUsdRate(pro.storageOverageMicroUsdPerGbMonth ?? 0);
  const overGb = Math.max(0, example.storedGbMonth - pro.includedStorageGbMonth);
  const includedPct = Math.round(
    (Math.min(pro.includedStorageGbMonth, example.storedGbMonth) / example.storedGbMonth) * 100,
  );
  const baseText = formatUsd(line('base_fee')?.amountMicroUsd ?? 0);
  const overText = formatUsd(line('storage_overage')?.amountMicroUsd ?? 0);
  const card = 'lm-panel flex flex-col gap-6 p-6';
  const price = 'text-5xl font-semibold tabular-nums tracking-tight';
  const unit = 'text-base font-normal tracking-normal text-[var(--color-ink-muted)]';

  return (
    <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-12 px-4 py-8 sm:px-8 sm:py-12">
      <header className="flex max-w-2xl flex-col gap-3">
        <h1 className="lm-title-1">Free to start. {formatUsd(pro.monthlyFeeMicroUsd)} to grow.</h1>
        <p className="lm-body-lg text-[var(--color-ink-muted)]">
          Views and downloads are always free. You only pay for extra storage.
        </p>
      </header>

      {checkout === 'canceled' && (
        <p role="status" className="lm-banner">
          Checkout was canceled. Nothing was charged.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="plan-free" className={card}>
          <div className="flex flex-col gap-2">
            <h2 id="plan-free" className="text-lg font-semibold text-[var(--color-ink-muted)]">
              Free
            </h2>
            <p className={price}>
              $0<span className={unit}> forever</span>
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            <Feature icon="image">{free.maxActiveGalleries ?? 'Unlimited'} galleries</Feature>
            <Feature icon="upload">{formatGigabytes(free.maxStorageBytes ?? 0)} storage</Feature>
            <Feature icon="eye">Free views and downloads</Feature>
            <Feature icon="lock">Never billed, no card</Feature>
          </ul>
          <div className="mt-auto">
            <Link href="/new" className={buttonClass('secondary', 'md', 'min-h-11')}>
              Create a gallery
            </Link>
          </div>
        </section>

        <section
          aria-labelledby="plan-pro"
          className={`${card} border-2 border-[var(--color-ink)]`}
        >
          <div className="flex flex-col gap-2">
            <h2 id="plan-pro" className="text-lg font-semibold text-[var(--color-ink-muted)]">
              Pro
            </h2>
            <p className={price}>
              {formatUsd(pro.monthlyFeeMicroUsd)}
              <span className={unit}> / month</span>
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            <Feature icon="image">Unlimited galleries</Feature>
            <Feature icon="upload">{pro.includedStorageGbMonth} GB-month included</Feature>
            <Feature icon="plus">{rate} per extra GB-month</Feature>
            <Feature icon="eye">Free views and downloads</Feature>
            <Feature icon="star">No Lumra badge</Feature>
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

      <section aria-labelledby="pricing-example" className="lm-panel flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="pricing-example" className="text-xl font-semibold">
            Storing {example.storedGbMonth} GB-month on Pro
          </h2>
          <p className="text-3xl font-semibold tabular-nums">
            {formatUsd(example.invoice.totalMicroUsd)}
            <span className={unit}> / month</span>
          </p>
        </div>
        <div
          role="img"
          aria-label={`${pro.includedStorageGbMonth} GB-month included in the ${baseText} subscription, plus ${overGb} GB-month extra at ${rate}, for ${overText}`}
          className="flex h-10 w-full overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-sunken)]"
        >
          <div className="bg-[var(--color-ink)]" style={{ width: `${includedPct}%` }} />
          <div className="bg-[var(--color-lumen)]" style={{ width: `${100 - includedPct}%` }} />
        </div>
        <dl className="grid gap-4 tabular-nums sm:grid-cols-2">
          <div className="flex items-start gap-3">
            <span aria-hidden className="mt-1.5 size-3 shrink-0 rounded-sm bg-[var(--color-ink)]" />
            <div>
              <dt className="text-[var(--color-ink-muted)]">
                {pro.includedStorageGbMonth} GB-month included
              </dt>
              <dd className="font-semibold">{baseText}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-1.5 size-3 shrink-0 rounded-sm bg-[var(--color-lumen)]"
            />
            <div>
              <dt className="text-[var(--color-ink-muted)]">
                {overGb} GB-month extra × {rate}
              </dt>
              <dd className="font-semibold">{overText}</dd>
            </div>
          </div>
        </dl>
        <p className="text-sm text-[var(--color-ink-muted)]">Before tax.</p>
      </section>

      <section aria-labelledby="pricing-faq" className="flex max-w-3xl flex-col gap-2">
        <h2 id="pricing-faq" className="text-xl font-semibold">
          Good to know
        </h2>
        <div>
          <Faq q="What is a GB-month?">
            Storage averaged over time. 20 GB kept for half a month is 10 GB-month. 1 GB is
            1,000,000,000 bytes, counting originals plus optimised copies.
          </Faq>
          <Faq q="What happens at the Free limit?">
            New uploads or galleries are refused. You are never charged and shared galleries stay
            online.
          </Faq>
          <Faq q="Can I cap my spending?">
            {cap !== null ? `Yes. The default is ${formatUsd(cap)}` : 'Yes. You set a limit'} of
            overage a month, adjustable, with alerts at{' '}
            {policy.defaultAlertThresholdsPct.join('%, ').replace(/, (\d+)$/, ' and $1')}%. Uploads
            past the cap are refused
            {cap !== null
              ? `; lagging usage readings can overshoot by at most ${formatUsd(spendCapToleranceMicroUsd(cap, policy))}.`
              : '.'}
          </Faq>
          <Faq q="What if a payment fails?">
            Uploads pause. Shared galleries stay online for{' '}
            {Math.round(policy.pastDueGraceMs / DAY_MS)} days, and your photos are kept{' '}
            {Math.round(policy.retentionAfterSuspensionMs / DAY_MS)} more.
          </Faq>
          <Faq q="Taxes and cancelling?">
            Prices are in US dollars, before tax. Cancel any time; Pro stays active until the end of
            the paid period.
          </Faq>
        </div>
      </section>
    </main>
  );
}
