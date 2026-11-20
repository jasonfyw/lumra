import { eq } from 'drizzle-orm';
import { isValidSpendCap, planBillsOverage } from '@lumra/billing';
import { BILLING_POLICY_V1 } from '@lumra/config';
import { spendingCapRequestSchema } from '@lumra/contracts';
import { billingAccounts, planRatesFromRow, plans, profiles } from '@lumra/db';
import { getAuthenticatedUser } from '@/lib/actor';
import { fail, ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  NO_STORE,
  UNAUTHENTICATED,
  crossOriginError,
  parseJsonBody,
  validation,
} from '@/lib/request-guards';
import { withRoute } from '@/lib/route';
import { getAccountUsageSummary } from '@/server/account';
import { reevaluateSpendAlerts } from '@/server/billing-state';
import { isBillingConfigured } from '@/server/stripe';

export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/billing/spending-cap` (PRD §10 "GET/PATCH /billing/usage", split; T32). The
 * signed-in owner sets their own monthly overage cap: whole cents from $0 to the platform maximum,
 * or `null` for the plan default. Pro only (Free has hard caps and is never billed). The cap
 * covers storage overage only (ADR-008): it gates new uploads at admission, and spend-cap alerts
 * are re-evaluated at once. Returns the updated spend summary.
 */
export const PATCH = withRoute(
  'PATCH /api/v1/billing/spending-cap',
  async (request, { requestId, log }) => {
    const csrf = crossOriginError(request, serverEnv().NEXT_PUBLIC_APP_URL);
    if (csrf) return fail(csrf, requestId);
    const user = await getAuthenticatedUser();
    if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });
    const body = await parseJsonBody(request, spendingCapRequestSchema);
    if (!body.ok) return fail(body.error, requestId);
    const cap = body.data.capMicroUsd;
    if (cap !== null && !isValidSpendCap(cap)) {
      return fail(
        validation('The cap must be whole cents between $0 and the maximum.', {
          minMicroUsd: 0,
          maxMicroUsd: BILLING_POLICY_V1.maxSpendCapMicroUsd,
        }),
        requestId,
      );
    }

    const db = getDb();
    await enforceRateLimit(
      request,
      'billingSettings',
      { kind: 'user', userId: user.userId },
      { db, log },
    );
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ plan: plans })
        .from(profiles)
        .innerJoin(plans, eq(plans.id, profiles.planId))
        .where(eq(profiles.userId, user.userId));
      if (!row || !planBillsOverage(planRatesFromRow(row.plan))) return false;
      await tx
        .update(billingAccounts)
        .set({ spendCapMicroUsd: cap })
        .where(eq(billingAccounts.userId, user.userId));
      return true;
    });
    if (!updated) {
      return fail(
        {
          code: 'conflict',
          message: 'Spending caps apply to Pro. Free has hard limits and is never billed.',
          retryable: false,
          details: { reason: 'not_pro' },
        },
        requestId,
        { headers: NO_STORE },
      );
    }
    log.info('spending cap updated', { accountId: user.userId, custom: cap !== null });
    await reevaluateSpendAlerts(db, user.userId, { traceId: `cap:${requestId}`, log });
    const summary = await getAccountUsageSummary(db, user, new Date(), {
      paymentsEnabled: isBillingConfigured(),
    });
    return ok(summary.spend, requestId, { headers: NO_STORE });
  },
);
