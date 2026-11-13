import Link from 'next/link';
import type { AccountUsageSummary } from '@lumra/contracts';
import { Icon, buttonClass } from '@/components/ui';
import { formatDate, formatGigabytes } from '@/lib/format';
import { BillingButton } from './billing-button';

/**
 * Billing state banners (T28/T30/T33): one calm, actionable message per condition, derived from
 * the server summary (never from redirect parameters). Used on `/account` and the dashboard.
 */
export type CheckoutReturn = 'success' | null;

export type BannerSummary = Pick<
  AccountUsageSummary,
  'plan' | 'billingStatus' | 'period' | 'billing' | 'storage' | 'delivery'
>;

interface Banner {
  key: string;
  tone: 'error' | 'cap' | 'neutral';
  title: string;
  body: string;
  action?: 'portal' | 'checkout' | 'account';
}

export function billingBanners(summary: BannerSummary, checkout: CheckoutReturn = null): Banner[] {
  const { billing } = summary;
  const banners: Banner[] = [];
  const date = (iso: string | null) => (iso ? formatDate(iso) : 'soon');
  const gb = (bytes: number | null) => (bytes === null ? 'the Free' : formatGigabytes(bytes));

  if (checkout === 'success') {
    banners.push(
      summary.plan === 'pro'
        ? {
            key: 'checkout',
            tone: 'neutral',
            title: 'Welcome to Pro',
            body: 'Your subscription is active. Galleries no longer show the Lumra badge.',
          }
        : {
            key: 'checkout',
            tone: 'neutral',
            title: 'Payment received — activating Pro',
            body: 'Pro switches on as soon as Stripe confirms the subscription, usually within a few seconds. Refresh this page to see it.',
          },
    );
  }

  switch (summary.billingStatus) {
    case 'past_due':
      banners.push({
        key: 'past_due',
        tone: 'error',
        title: 'Your last payment failed',
        body: `Uploads and new “Download all” archives are paused. Shared galleries stay online until ${date(billing.deliverySuspendsAt)}; update your payment method to restore everything.`,
        action: 'portal',
      });
      break;
    case 'restricted':
      banners.push({
        key: 'restricted',
        tone: 'error',
        title: 'Your galleries are offline',
        body: `Payment is overdue, so shared galleries are no longer shown to viewers. Your photos are kept until ${date(billing.retentionEndsAt)}. Update your payment method to bring everything back.`,
        action: 'portal',
      });
      break;
    case 'canceled':
      banners.push({
        key: 'canceled',
        tone: 'error',
        title: 'Your Pro subscription has ended',
        body: `Your account is above the Free limits (${billing.galleries.max ?? 'a few'} galleries, ${gb(summary.storage.limitBytes)}), so shared galleries are offline and uploads are paused. Delete galleries or photos to fit Free, or subscribe again. Your photos are kept until ${date(billing.retentionEndsAt)}.`,
        action: 'checkout',
      });
      break;
  }

  if (billing.deliveryPaused === 'free_delivery_cap') {
    banners.push({
      key: 'delivery_cap',
      tone: 'cap',
      title: 'Monthly delivery limit reached',
      body: `Your galleries used this month’s Free delivery allowance (${gb(summary.delivery.limitBytes)}), so viewers see “temporarily unavailable” until ${date(summary.period.end)}. Upgrade to Pro to keep sharing now.`,
      action: 'checkout',
    });
  } else if (billing.deliveryPaused === 'spend_cap') {
    banners.push({
      key: 'spend_cap',
      tone: 'cap',
      title: 'Spending cap reached',
      body: `Your galleries reached this period’s overage spending cap, so viewers see a bandwidth-limit notice until ${date(summary.period.end)}. Raise the cap to resume delivery now.`,
      action: 'account',
    });
  }

  if (billing.cancelAtPeriodEnd && summary.billingStatus === 'active') {
    banners.push({
      key: 'cancel_at_period_end',
      tone: 'neutral',
      title: `Pro ends on ${date(summary.period.end)}`,
      body: 'You can keep using Pro until then, or resume the subscription from the billing portal.',
      action: 'portal',
    });
  }
  return banners;
}

const TONE_CLASS: Record<Banner['tone'], string> = {
  error: 'lm-banner lm-banner-error',
  cap: 'lm-banner lm-banner-cap',
  neutral: 'lm-banner',
};

export function BillingBanners({
  summary,
  checkout = null,
  showAccountLink = false,
}: {
  summary: BannerSummary;
  checkout?: CheckoutReturn;
  /** On pages other than /account, link there instead of opening Stripe directly. */
  showAccountLink?: boolean;
}) {
  const banners = billingBanners(summary, checkout);
  if (banners.length === 0) return null;
  const { paymentsEnabled, hasCustomer } = summary.billing;
  return (
    <div className="flex flex-col gap-3">
      {banners.map((b) => (
        <div
          key={b.key}
          role={b.tone === 'error' ? 'alert' : 'status'}
          className={`${TONE_CLASS[b.tone]} flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`}
        >
          <div className="flex items-start gap-3">
            <Icon name={b.tone === 'neutral' ? 'check' : 'alert'} className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">{b.title}</p>
              <p className="text-[13px] leading-[18px]">{b.body}</p>
            </div>
          </div>
          {b.action &&
            (showAccountLink || b.action === 'account' ? (
              <Link
                href="/account"
                className={buttonClass(
                  'secondary',
                  'sm',
                  'min-h-11 shrink-0 self-start sm:self-center',
                )}
              >
                {b.action === 'account' ? 'Spending cap' : 'Billing'}
              </Link>
            ) : b.action === 'portal' ? (
              <BillingButton
                action="portal"
                variant="secondary"
                disabled={!paymentsEnabled || !hasCustomer}
                className="shrink-0"
              >
                Update payment
              </BillingButton>
            ) : (
              <BillingButton
                action="checkout"
                variant="primary"
                disabled={!paymentsEnabled}
                className="shrink-0"
              >
                Upgrade to Pro
              </BillingButton>
            ))}
        </div>
      ))}
    </div>
  );
}
