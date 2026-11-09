import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { AccountUsageSummary, UsageMeter } from '@lumra/contracts';
import { getAuthenticatedUser } from '@/lib/actor';
import { getDb } from '@/lib/db';
import { formatDate, formatGigabytes } from '@/lib/format';
import { getAccountUsageSummary } from '@/server/account';
import { signOutAction } from '../auth/actions';
import { AppHeader, Tag, buttonClass } from '@/components/ui';

export const metadata = { title: 'Account' };
// Per-user, auth-gated: never prerendered or cached.
export const dynamic = 'force-dynamic';

const PLAN_LABEL: Record<AccountUsageSummary['plan'], string> = { free: 'Free', pro: 'Pro' };

const STATUS_NOTE: Partial<Record<AccountUsageSummary['billingStatus'], string>> = {
  past_due: 'Payment past due',
  restricted: 'Restricted',
  canceled: 'Canceled',
};

const section = 'lm-panel flex flex-col gap-4 p-6';
const disabledButton = buttonClass('secondary', 'md', 'self-start');

function UsageRow({ label, meter, extra }: { label: string; meter: UsageMeter; extra?: string }) {
  let value: string;
  if (!meter.tracked || meter.usedBytes === null) value = 'Not yet tracked';
  else if (meter.limitBytes === null) value = formatGigabytes(meter.usedBytes);
  else value = `${formatGigabytes(meter.usedBytes)} of ${formatGigabytes(meter.limitBytes)}`;

  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-[var(--color-ink-muted)]">{label}</dt>
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

/** Account page (PRD §4 `/account`, FR-N03): email, plan, usage summary, billing placeholders. */
export default async function AccountPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/auth?returnTo=%2Faccount');

  const summary = await getAccountUsageSummary(getDb(), user);
  const statusNote = STATUS_NOTE[summary.billingStatus];
  const items = summary.storage.itemCount;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        actions={
          <>
            <nav aria-label="Account" className="flex items-center gap-1">
              <Link href="/dashboard" className={buttonClass('ghost')}>
                Galleries
              </Link>
            </nav>
            <form action={signOutAction}>
              <button type="submit" className={buttonClass('ghost')}>
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
        <h1 className="lm-title-1">Account</h1>

        <section aria-labelledby="account-profile" className={section}>
          <h2 id="account-profile" className="text-xl font-semibold">
            Profile
          </h2>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-[var(--color-ink-muted)]">Email</dt>
              <dd className="break-all">{summary.email ?? 'Unknown'}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-[var(--color-ink-muted)]">Plan</dt>
              <dd>
                <Tag tone={summary.plan === 'pro' ? 'pro' : 'surface'}>
                  {PLAN_LABEL[summary.plan]}
                </Tag>
                {statusNote && <span className="text-[var(--color-danger)]"> · {statusNote}</span>}{' '}
                <Link href="/pricing" className="underline underline-offset-4">
                  See plans
                </Link>
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="account-usage" className={section}>
          <div className="flex flex-col gap-1">
            <h2 id="account-usage" className="text-xl font-semibold">
              Usage
            </h2>
            <p className="text-sm text-[var(--color-ink-muted)]">
              Billing period {formatDate(summary.period.start)} – {formatDate(summary.period.end)}{' '}
              (UTC). Decimal units: 1 GB = 1,000,000,000 bytes.
            </p>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <UsageRow
              label="Storage"
              meter={summary.storage}
              extra={`${items} ${items === 1 ? 'photo' : 'photos'}`}
            />
            <UsageRow label="Delivery this period" meter={summary.delivery} />
          </dl>
        </section>

        <section aria-labelledby="account-billing" className={section}>
          <div className="flex flex-col gap-1">
            <h2 id="account-billing" className="text-xl font-semibold">
              Billing
            </h2>
            <p className="text-sm text-[var(--color-ink-muted)]">
              Available when paid plans launch.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">Invoices</h3>
              <p className="text-sm text-[var(--color-ink-muted)]">
                Monthly invoices and receipts will be listed here.
              </p>
              <button type="button" disabled className={disabledButton}>
                View invoices
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">Spending cap and alerts</h3>
              <p className="text-sm text-[var(--color-ink-muted)]">
                Pro accounts will set a monthly overage cap and get email alerts at 50%, 80% and
                100% of it.
              </p>
              <button type="button" disabled className={disabledButton}>
                Set spending cap
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
