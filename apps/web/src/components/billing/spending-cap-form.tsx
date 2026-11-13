'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { parseUsdToMicroUsd } from '@lumra/billing';
import type { AccountSpend, ApiResponse } from '@lumra/contracts';
import { buttonClass } from '@/components/ui';
import { formatUsd } from '@/lib/format';

/** Dollars for the input field ("10.00" → "10", "12.50" stays). */
function dollarsText(microUsd: number): string {
  const cents = Math.round(microUsd / 10_000);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * Spending cap control (T32, PRD §9.4): $0 to the platform maximum, default $10. Parsing is exact
 * (`parseUsdToMicroUsd`); the server validates again. Shows the estimate against the cap and the
 * alerts already sent this period.
 */
export function SpendingCapForm({ spend }: { spend: AccountSpend }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(dollarsText(spend.capMicroUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(capMicroUsd: number | null) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/v1/billing/spending-cap', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capMicroUsd }),
      });
      const body = (await res.json()) as ApiResponse<AccountSpend>;
      if (body.error) {
        setError(body.error.message);
        return;
      }
      setValue(dollarsText(body.data.capMicroUsd));
      setSaved(true);
      router.refresh();
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const micro = parseUsdToMicroUsd(value);
    if (micro === null || micro > spend.maxCapMicroUsd) {
      setError(
        `Enter an amount from $0 to ${formatUsd(spend.maxCapMicroUsd)}, in dollars and cents.`,
      );
      return;
    }
    void save(micro);
  }

  const reached = new Set(spend.alertsReached);
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <p className="text-sm text-[var(--color-ink-muted)]">
        Estimated overage this period:{' '}
        <span className="font-medium text-[var(--color-ink)] tabular-nums">
          {formatUsd(spend.estimatedOverageMicroUsd)}
        </span>{' '}
        of {formatUsd(spend.capMicroUsd)} ({spend.percentOfCap}%). The base fee and taxes are not
        counted.
      </p>
      <progress
        className="h-1.5 w-full max-w-xs accent-[var(--color-accent)]"
        max={100}
        value={spend.percentOfCap}
        aria-label={`Spending cap: ${spend.percentOfCap}% used`}
      />
      <div className="lm-field max-w-xs">
        <label htmlFor={`${id}-cap`} className="lm-field-label">
          Monthly overage cap (USD)
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true">$</span>
          <input
            id={`${id}-cap`}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            aria-describedby={`${id}-hint`}
            aria-invalid={error ? true : undefined}
            className="lm-input tabular-nums"
          />
        </div>
        <p id={`${id}-hint`} className="lm-field-hint">
          $0 to {formatUsd(spend.maxCapMicroUsd)}. Default {formatUsd(spend.defaultCapMicroUsd)}. At
          the cap, uploads that would exceed it are refused and delivery pauses.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'md', 'min-h-11')}>
          {busy ? 'Saving…' : 'Save cap'}
        </button>
        {spend.custom && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className={buttonClass('ghost', 'md', 'min-h-11')}
          >
            Use default ({formatUsd(spend.defaultCapMicroUsd)})
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="lm-field-error">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="lm-field-hint">
          Saved.
        </p>
      )}
      <p className="text-sm text-[var(--color-ink-muted)]">
        Alerts at{' '}
        {spend.thresholdsPct.map((t, i) => (
          <span key={t}>
            {i > 0 && (i === spend.thresholdsPct.length - 1 ? ' and ' : ', ')}
            <span className={reached.has(t) ? 'font-medium text-[var(--color-ink)]' : undefined}>
              {t}%{reached.has(t) ? ' (sent)' : ''}
            </span>
          </span>
        ))}{' '}
        of the cap, once per billing period.
      </p>
    </form>
  );
}
