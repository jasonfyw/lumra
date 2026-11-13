import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RATE_CARD_V1 } from '@lumra/config';
import { AccountView } from '@/components/billing/account-view';
import { AppHeader } from '@/components/ui';
import { ACCOUNT_FIXTURE_STATES, makeAccountFixture } from './fixture';

/**
 * Dev-only fixture for the account page billing states (T28–T33): `/dev/account?state=past_due`.
 * `state` is one of ACCOUNT_FIXTURE_STATES. Buttons render but Stripe calls are not stubbed.
 * Returns 404 in production builds and is not linked from anywhere.
 */
export const metadata: Metadata = {
  title: 'Account fixture',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DevAccountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const raw = first((await searchParams).state);
  const state = ACCOUNT_FIXTURE_STATES.find((s) => s === raw) ?? 'free';
  const { summary, checkout } = makeAccountFixture(state);
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <AccountView
        summary={summary}
        checkout={checkout}
        proMonthlyFeeMicroUsd={RATE_CARD_V1.pro.monthlyFeeMicroUsd}
      />
    </div>
  );
}
