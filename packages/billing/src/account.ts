import { BILLING_POLICY_V1, type BillingPolicy } from '@lumra/config';
import { type TransitionTable, assertTransition } from '@lumra/domain';

/**
 * Billing account state machine (PRD §7, §9.4). Persisted transitions are driven by confirmed
 * Stripe webhooks and the past-due timer (T30/T33); the time-based consequences are *derived*
 * by `deriveBillingRestrictions` so a missed cron can never leave access wider than policy.
 */
export const BILLING_ACCOUNT_STATUSES = [
  'free',
  'active',
  'past_due',
  'restricted',
  'canceled',
] as const;
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number];

export const BILLING_ACCOUNT_TRANSITIONS: TransitionTable<BillingAccountStatus> = {
  free: ['active'],
  active: ['past_due', 'canceled'],
  past_due: ['active', 'restricted', 'canceled'],
  restricted: ['active', 'canceled'],
  /** Re-subscribe, or fall back to Free once usage fits Free caps (T30). */
  canceled: ['active', 'free'],
};

export function assertBillingTransition(
  from: BillingAccountStatus,
  to: BillingAccountStatus,
): void {
  assertTransition('billing_account', BILLING_ACCOUNT_TRANSITIONS, from, to);
}

export interface BillingAccountState {
  status: BillingAccountStatus;
  /** When the account entered `past_due` (start of the grace clock). Required for past_due/restricted. */
  pastDueSince?: Date | null;
  /** When public delivery was actually suspended, if persisted; otherwise derived from the grace. */
  restrictedSince?: Date | null;
  canceledAt?: Date | null;
}

export type RestrictionReason = 'past_due' | 'grace_elapsed' | 'canceled';

export interface BillingRestrictions {
  /** Status after applying time-based policy: `past_due` past its grace reads as `restricted`. */
  effectiveStatus: BillingAccountStatus;
  uploadsAllowed: boolean;
  archivesAllowed: boolean;
  publicDeliveryAllowed: boolean;
  /** When public delivery stops (past_due only). */
  deliverySuspendsAt: Date | null;
  /** End of the media-preservation window. Deletion still requires explicit policy + notice. */
  retentionEndsAt: Date | null;
  reasons: RestrictionReason[];
}

export class MissingBillingTimestampError extends Error {
  constructor(status: BillingAccountStatus, field: string) {
    super(`Billing account in ${status} requires ${field}`);
    this.name = 'MissingBillingTimestampError';
  }
}

const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);

export function deriveBillingRestrictions(
  account: BillingAccountState,
  now: Date,
  policy: BillingPolicy = BILLING_POLICY_V1,
): BillingRestrictions {
  const open: BillingRestrictions = {
    effectiveStatus: account.status,
    uploadsAllowed: true,
    archivesAllowed: true,
    publicDeliveryAllowed: true,
    deliverySuspendsAt: null,
    retentionEndsAt: null,
    reasons: [],
  };

  switch (account.status) {
    case 'free':
    case 'active':
      return open;

    case 'past_due': {
      if (!account.pastDueSince) throw new MissingBillingTimestampError('past_due', 'pastDueSince');
      const suspendsAt = addMs(account.pastDueSince, policy.pastDueGraceMs);
      const graceElapsed = now.getTime() >= suspendsAt.getTime();
      return {
        effectiveStatus: graceElapsed ? 'restricted' : 'past_due',
        uploadsAllowed: false,
        archivesAllowed: false,
        publicDeliveryAllowed: !graceElapsed,
        deliverySuspendsAt: suspendsAt,
        retentionEndsAt: addMs(suspendsAt, policy.retentionAfterSuspensionMs),
        reasons: graceElapsed ? ['past_due', 'grace_elapsed'] : ['past_due'],
      };
    }

    case 'restricted': {
      const suspendedAt =
        account.restrictedSince ??
        (account.pastDueSince ? addMs(account.pastDueSince, policy.pastDueGraceMs) : null);
      if (!suspendedAt) throw new MissingBillingTimestampError('restricted', 'restrictedSince');
      return {
        effectiveStatus: 'restricted',
        uploadsAllowed: false,
        archivesAllowed: false,
        publicDeliveryAllowed: false,
        deliverySuspendsAt: suspendedAt,
        retentionEndsAt: addMs(suspendedAt, policy.retentionAfterSuspensionMs),
        reasons: ['past_due', 'grace_elapsed'],
      };
    }

    case 'canceled': {
      if (!account.canceledAt) throw new MissingBillingTimestampError('canceled', 'canceledAt');
      return {
        effectiveStatus: 'canceled',
        uploadsAllowed: false,
        archivesAllowed: false,
        publicDeliveryAllowed: false,
        deliverySuspendsAt: account.canceledAt,
        retentionEndsAt: addMs(account.canceledAt, policy.retentionAfterSuspensionMs),
        reasons: ['canceled'],
      };
    }
  }
}
