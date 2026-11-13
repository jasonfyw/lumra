import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RATE_CARD_V1 } from '@lumra/config';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { ACCOUNT_FIXTURE_STATES, makeAccountFixture } from '@/app/dev/account/fixture';
import { formatUsd, formatUsdRate } from '@/lib/format';
import { planBlockFor } from '@/components/upload/gallery-uploader';
import { AccountView } from './account-view';
import { billingBanners } from './billing-banners';
import { PricingView, workedExample } from './pricing-view';

describe('pricing (PRD §9.3)', () => {
  it('rates the worked example with @lumra/billing: $4.20', () => {
    const { invoice } = workedExample(RATE_CARD_V1.pro);
    expect(invoice.totalMicroUsd).toBe(4_200_000);
    expect(formatUsd(invoice.totalMicroUsd)).toBe('$4.20');
  });

  it('renders every number from the rate card it is given', () => {
    render(
      <PricingView
        free={RATE_CARD_V1.free}
        pro={RATE_CARD_V1.pro}
        viewer={{ kind: 'anonymous' }}
      />,
    );
    expect(screen.getByText('$4.20')).toBeInTheDocument();
    expect(screen.getByText(/2 active galleries/)).toBeInTheDocument();
    expect(screen.getByText(/20 GB-month of storage included/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.10 per GB-month and \$0\.03 per GB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to upgrade' })).toHaveAttribute(
      'href',
      '/auth?returnTo=%2Fpricing',
    );
  });

  it('disables upgrade with a reason when payments are not configured', () => {
    render(
      <PricingView
        free={RATE_CARD_V1.free}
        pro={RATE_CARD_V1.pro}
        viewer={{ kind: 'free', paymentsEnabled: false }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeDisabled();
    expect(screen.getByText(/Payments aren’t set up/)).toBeInTheDocument();
  });

  it('formats integer micro-USD without float drift', () => {
    expect(formatUsd(2_000_000)).toBe('$2.00');
    expect(formatUsd(4_205_000)).toBe('$4.21');
    expect(formatUsd(4_204_999)).toBe('$4.20');
    expect(formatUsdRate(100_000)).toBe('$0.10');
    expect(formatUsdRate(30_000)).toBe('$0.03');
  });
});

describe('/account billing states', () => {
  it('every fixture state renders a contract-valid page', () => {
    for (const state of ACCOUNT_FIXTURE_STATES) {
      const { summary, checkout } = makeAccountFixture(state);
      const { unmount } = render(
        <AccountView summary={summary} checkout={checkout} proMonthlyFeeMicroUsd={2_000_000} />,
      );
      expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
      unmount();
    }
  });

  it('shows one actionable banner per condition', () => {
    const keys = (state: (typeof ACCOUNT_FIXTURE_STATES)[number]) => {
      const { summary, checkout } = makeAccountFixture(state);
      return billingBanners(summary, checkout).map((b) => b.key);
    };
    expect(keys('free')).toEqual([]);
    expect(keys('pro')).toEqual([]);
    expect(keys('checkout_pending')).toEqual(['checkout']);
    expect(keys('past_due')).toEqual(['past_due']);
    expect(keys('restricted')).toEqual(['restricted']);
    expect(keys('canceled')).toEqual(['canceled']);
    expect(keys('free_delivery_paused')).toEqual(['delivery_cap']);
    expect(keys('pro_canceling')).toEqual(['cancel_at_period_end']);
    expect(keys('pro_alert_80')).toEqual(['spend_alert']);
    expect(keys('pro_spend_cap')).toEqual(['spend_cap']);
  });

  it('the checkout redirect alone never claims Pro is active', () => {
    const { summary } = makeAccountFixture('checkout_pending');
    expect(billingBanners(summary, 'success')[0]?.title).toMatch(/activating Pro/);
  });

  it('disables Stripe buttons when payments are not configured', () => {
    const { summary } = makeAccountFixture('unconfigured');
    render(<AccountView summary={summary} proMonthlyFeeMicroUsd={2_000_000} />);
    expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeDisabled();
  });
});

describe('uploader plan prompts (T28)', () => {
  it('maps admission refusals to the way out', () => {
    expect(planBlockFor([{ error: { code: 'quota_exceeded' } }])?.href).toBe('/pricing');
    expect(planBlockFor([{ error: { code: 'spend_cap_reached' } }])?.href).toBe('/account');
    expect(planBlockFor([{ error: { code: 'forbidden' } }])?.title).toMatch(/paused/);
    expect(planBlockFor([{ error: { code: 'quota_exceeded', requiresAuth: true } }])).toBeNull();
    expect(planBlockFor([{ error: null }])).toBeNull();
  });
});

describe('spending cap + invoices (T31/T32)', () => {
  it('shows the cap form with the estimate and alerts for Pro, and the invoice list', () => {
    const { summary } = makeAccountFixture('pro_alert_80');
    render(<AccountView summary={summary} proMonthlyFeeMicroUsd={2_000_000} />);
    expect(screen.getByLabelText('Monthly overage cap (USD)')).toHaveValue('10');
    expect(screen.getByText('$8.42')).toBeInTheDocument();
    expect(screen.getByText('80% (sent)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View\s+invoice A1B2C3D4-0002/ })).toHaveAttribute(
      'href',
      'https://invoice.stripe.com/i/fixture_2',
    );
  });

  it('Free has no cap control', () => {
    const { summary } = makeAccountFixture('free');
    render(<AccountView summary={summary} proMonthlyFeeMicroUsd={2_000_000} />);
    expect(screen.queryByLabelText('Monthly overage cap (USD)')).toBeNull();
    expect(screen.getByText(/Free never bills overage/)).toBeInTheDocument();
  });
});
