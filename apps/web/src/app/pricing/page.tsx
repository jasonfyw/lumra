import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { RATE_CARD_V1, type PlanRates } from '@lumra/config';
import { planRatesFromRow, plans, profiles } from '@lumra/db';
import { getAuthenticatedUser } from '@/lib/actor';
import { getDb } from '@/lib/db';
import { logger } from '@/lib/log';
import { PricingView, type PricingViewer } from '@/components/billing/pricing-view';
import { isBillingConfigured } from '@/server/stripe';
import { AppHeader, buttonClass } from '@/components/ui';

export const metadata = { title: 'Pricing' };
// Shows the signed-in user's upgrade state and the current rate card from the database.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Current rate card from `plans` (the authoritative, versioned copy). Falls back to the v1 seed
 * when no database is configured (local preview / CI), which equals the migration seed.
 */
async function currentRates(): Promise<{ free: PlanRates; pro: PlanRates }> {
  try {
    const rows = await getDb().select().from(plans);
    const byId = new Map(rows.map((r) => [r.id, planRatesFromRow(r)]));
    return {
      free: byId.get('free') ?? RATE_CARD_V1.free,
      pro: byId.get('pro') ?? RATE_CARD_V1.pro,
    };
  } catch (error) {
    logger.warn('pricing: falling back to the seeded rate card', { err: error });
    return RATE_CARD_V1;
  }
}

async function viewerState(): Promise<PricingViewer> {
  const user = await getAuthenticatedUser();
  if (!user) return { kind: 'anonymous' };
  const [profile] = await getDb()
    .select({ planId: profiles.planId })
    .from(profiles)
    .where(eq(profiles.userId, user.userId));
  return profile?.planId === 'pro'
    ? { kind: 'pro' }
    : { kind: 'free', paymentsEnabled: isBillingConfigured() };
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [{ free, pro }, viewer] = await Promise.all([currentRates(), viewerState()]);
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        actions={
          viewer.kind === 'anonymous' ? (
            <Link href="/auth?returnTo=%2Fpricing" className={buttonClass('ghost')}>
              Sign in
            </Link>
          ) : (
            <Link href="/account" className={buttonClass('ghost')}>
              Account
            </Link>
          )
        }
      />
      <PricingView
        free={free}
        pro={pro}
        viewer={viewer}
        checkout={params.checkout === 'canceled' ? 'canceled' : null}
      />
    </div>
  );
}
