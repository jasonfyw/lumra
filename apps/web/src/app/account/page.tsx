import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { RATE_CARD_V1 } from '@lumra/config';
import { plans } from '@lumra/db';
import { getAuthenticatedUser } from '@/lib/actor';
import { getDb } from '@/lib/db';
import { getAccountUsageSummary } from '@/server/account';
import { isBillingConfigured } from '@/server/stripe';
import { AccountView } from '@/components/billing/account-view';
import { signOutAction } from '../auth/actions';
import { AppHeader, buttonClass } from '@/components/ui';

export const metadata = { title: 'Account' };
// Per-user, auth-gated: never prerendered or cached.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Account page (PRD §4 `/account`, FR-N03, T28–T33). `?checkout=success` only changes wording
 * ("activating Pro"); the plan shown is always the webhook-confirmed state from the database.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/auth?returnTo=%2Faccount');

  const params = await searchParams;
  const db = getDb();
  const [summary, [pro]] = await Promise.all([
    getAccountUsageSummary(db, user, new Date(), { paymentsEnabled: isBillingConfigured() }),
    db.select({ fee: plans.monthlyFeeMicroUsd }).from(plans).where(eq(plans.id, 'pro')),
  ]);

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
      <AccountView
        summary={summary}
        checkout={params.checkout === 'success' ? 'success' : null}
        proMonthlyFeeMicroUsd={pro?.fee ?? RATE_CARD_V1.pro.monthlyFeeMicroUsd}
      />
    </div>
  );
}
