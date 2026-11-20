'use client';

import { useState } from 'react';
import type { ApiResponse, BillingRedirectResponse } from '@lumra/contracts';
import { buttonClass } from '@/components/ui';

const ENDPOINT = {
  checkout: '/api/v1/billing/checkout',
  portal: '/api/v1/billing/portal',
} as const;

/**
 * Opens Stripe Checkout (upgrade) or the Billing Portal (manage). The server creates the session
 * and returns its hosted URL; nothing about the plan changes in the browser — Pro is granted by
 * the signed webhook. Disabled with a reason when payments are not configured (T29).
 */
export function BillingButton({
  action,
  children,
  variant = 'primary',
  disabled = false,
  disabledReason,
  className = '',
}: {
  action: keyof typeof ENDPOINT;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'lumen';
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT[action], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json()) as ApiResponse<BillingRedirectResponse>;
      if (body.error) {
        setError(body.error.message);
        setBusy(false);
        return;
      }
      window.location.assign(body.data.url);
    } catch {
      setError('Network error. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col items-start gap-2 ${className}`}>
      <button
        type="button"
        onClick={go}
        disabled={disabled || busy}
        aria-describedby={disabled && disabledReason ? `${action}-disabled-reason` : undefined}
        className={buttonClass(variant, 'md', 'min-h-11')}
      >
        {busy ? 'Opening Stripe…' : children}
      </button>
      {disabled && disabledReason && (
        <p id={`${action}-disabled-reason`} className="lm-field-hint">
          {disabledReason}
        </p>
      )}
      {error && (
        <p role="alert" className="lm-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
