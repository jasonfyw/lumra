import type { AccountInvoice } from '@lumra/contracts';
import { Tag } from '@/components/ui';
import { formatDate } from '@/lib/format';

const STATUS: Record<AccountInvoice['status'], { label: string; tone?: 'ready' | 'failed' }> = {
  draft: { label: 'Draft' },
  open: { label: 'Due', tone: 'failed' },
  paid: { label: 'Paid', tone: 'ready' },
  uncollectible: { label: 'Unpaid', tone: 'failed' },
  void: { label: 'Void' },
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** Invoice history (T31) from webhook-stored invoices; links open Stripe's hosted pages. */
export function InvoiceList({ invoices }: { invoices: AccountInvoice[] }) {
  if (invoices.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        Invoices appear here after your first Pro payment.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-hairline)]">
      {invoices.map((inv) => {
        const status = STATUS[inv.status];
        return (
          <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex flex-col">
              <span className="tabular-nums">{formatDate(inv.createdAt)}</span>
              {inv.number && (
                <span className="text-[13px] text-[var(--color-ink-muted)]">{inv.number}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="tabular-nums">{money(inv.totalCents, inv.currency)}</span>
              <Tag tone={status.tone}>{status.label}</Tag>
              {inv.hostedInvoiceUrl && (
                <a
                  href={inv.hostedInvoiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline underline-offset-4"
                  aria-label={`${inv.status === 'open' ? 'Pay' : 'View'} invoice ${inv.number ?? formatDate(inv.createdAt)}`}
                >
                  {inv.status === 'open' ? 'Pay' : 'View'}
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
