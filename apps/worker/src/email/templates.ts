import type { EmailSendMessage, EmailTemplate } from '@lumra/contracts';
import { renderLayout, type RenderedEmail } from './layout';

export interface RenderOptions {
  /** Public app origin without a trailing slash, e.g. `https://www.lumra.photos`. */
  appUrl: string;
}

const ACCOUNT_FOOTNOTE =
  'You are receiving this because it concerns your Lumra account. Questions? Just reply to this email.';

/** Integer micro-USD to `$1.25` (half up to cents; money is never a float in the ledger). */
export function formatMicroUsd(micro: number): string {
  const cents = Math.floor((Math.max(0, Math.trunc(micro)) + 5_000) / 10_000);
  const dollars = Math.floor(cents / 100);
  return `$${dollars.toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}

function num(data: EmailSendMessage['data'], key: string): number | null {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Renders one `email.send` template. Subjects are plain; no personal data is interpolated. */
export function renderEmail(
  template: EmailTemplate,
  data: EmailSendMessage['data'],
  opts: RenderOptions,
): RenderedEmail {
  const account = `${opts.appUrl}/account`;
  switch (template) {
    case 'pro_activated':
      return renderLayout('Welcome to Lumra Pro', {
        preheader: 'Your Pro plan is active.',
        heading: 'Lumra Pro is active',
        paragraphs: [
          'Thanks for upgrading. Your Pro plan is active, with more storage and room for more galleries.',
          'You can see your plan, usage and invoices on your account page.',
        ],
        cta: { label: 'Open your account', url: account },
        footnote: ACCOUNT_FOOTNOTE,
      });
    case 'payment_failed':
      return renderLayout('Action needed: your Lumra payment failed', {
        preheader: 'We could not charge your payment method.',
        heading: 'We could not process your payment',
        paragraphs: [
          'Your latest Lumra payment did not go through. Your galleries are still available for now, but new uploads are paused until this is resolved.',
          'Please update your payment method. If the payment stays unresolved, your galleries will stop being viewable after the grace period.',
        ],
        cta: { label: 'Update payment method', url: account },
        footnote: ACCOUNT_FOOTNOTE,
      });
    case 'payment_recovered':
      return renderLayout('Your Lumra payment went through', {
        preheader: 'Everything is back to normal.',
        heading: 'Payment received, thank you',
        paragraphs: ['Your payment went through and your account is in good standing again.'],
        cta: { label: 'Open your account', url: account },
        footnote: ACCOUNT_FOOTNOTE,
      });
    case 'delivery_suspended':
      return renderLayout('Your Lumra galleries are paused', {
        preheader: 'Public delivery is paused until payment is resolved.',
        heading: 'Your galleries are paused',
        paragraphs: [
          'Because your payment is still unresolved after the grace period, your galleries are no longer viewable by visitors.',
          'Nothing has been deleted. Update your payment method and delivery resumes right away.',
        ],
        cta: { label: 'Update payment method', url: account },
        footnote: ACCOUNT_FOOTNOTE,
      });
    case 'subscription_ended':
      return renderLayout('Your Lumra Pro plan has ended', {
        preheader: 'Your account moved to the Free plan.',
        heading: 'Your Pro plan has ended',
        paragraphs: [
          'Your account is now on the Free plan. Free has limits on galleries and storage, so some content may be unavailable until you are within the limits or upgrade again.',
          'You can download or delete content, or resubscribe, from your account.',
        ],
        cta: { label: 'Review your account', url: account },
        footnote: ACCOUNT_FOOTNOTE,
      });
    case 'spend_cap_alert': {
      const pct = num(data, 'thresholdPct');
      const spend = num(data, 'spendMicroUsd');
      const cap = num(data, 'capMicroUsd');
      const reached = pct !== null && pct >= 100;
      const label = pct === null ? 'your spend cap' : `${pct}% of your spend cap`;
      const figures =
        spend !== null && cap !== null
          ? `So far this billing period: ${formatMicroUsd(spend)} of your ${formatMicroUsd(cap)} cap.`
          : null;
      return renderLayout(
        reached ? 'You have reached your Lumra spend cap' : `Lumra usage alert: ${label}`,
        {
          preheader: reached
            ? 'New uploads are paused.'
            : 'Storage overage is approaching your cap.',
          heading: reached ? 'You have reached your spend cap' : `You have used ${label}`,
          paragraphs: [
            ...(figures ? [figures] : []),
            reached
              ? 'New uploads are paused so you are never charged beyond your cap. Existing galleries keep working. Raise the cap or free up space to upload again.'
              : 'Storage overage on your Pro plan is approaching the cap you set. At the cap, new uploads pause. You can change the cap at any time.',
          ],
          cta: { label: 'Manage spend cap', url: account },
          footnote: ACCOUNT_FOOTNOTE,
        },
      );
    }
  }
}
