'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { AuthFlowParams } from '@/lib/return-to';
import { sendOtpAction, verifyOtpAction, type AuthFormState } from './actions';

/** Matches Supabase's per-address `max_frequency` (infra/supabase/config.toml). */
const RESEND_COOLDOWN_S = 60;

const initialState: AuthFormState = {
  step: 'email',
  email: '',
  error: null,
  notice: null,
  sentAt: null,
};

const button =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 font-medium text-white disabled:opacity-60';
const input =
  'min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-white px-3 text-base';

function useCooldown(sentAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sentAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sentAt]);
  if (!sentAt) return 0;
  return Math.max(0, RESEND_COOLDOWN_S - Math.floor((now - sentAt) / 1000));
}

function FlowFields({ flow }: { flow: AuthFlowParams }) {
  return (
    <>
      <input type="hidden" name="returnTo" value={flow.returnTo} />
      {flow.intent && <input type="hidden" name="intent" value={flow.intent} />}
      {flow.galleryId && <input type="hidden" name="galleryId" value={flow.galleryId} />}
    </>
  );
}

export function AuthForm({
  flow,
  initialError,
}: {
  flow: AuthFlowParams;
  initialError: string | null;
}) {
  const [sendState, send, sending] = useActionState(sendOtpAction, {
    ...initialState,
    error: initialError,
  });
  const [verifyState, verify, verifying] = useActionState(verifyOtpAction, initialState);
  const [editingEmail, setEditingEmail] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const cooldown = useCooldown(sendState.sentAt);

  const onCodeStep = sendState.step === 'code' && !editingEmail;
  // The latest action decides which message is current.
  const error = onCodeStep ? (verifyState.error ?? sendState.error) : sendState.error;
  const notice = onCodeStep && !verifyState.error ? sendState.notice : null;

  useEffect(() => {
    if (onCodeStep) codeRef.current?.focus();
  }, [onCodeStep, sendState.sentAt]);

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite" role="status" className="min-h-6 text-[var(--color-ink-muted)]">
        {notice}
      </div>
      {error && (
        <p role="alert" className="text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {!onCodeStep ? (
        <form
          action={(formData) => {
            setEditingEmail(false);
            return send(formData);
          }}
          className="flex flex-col gap-3"
          noValidate
        >
          <FlowFields flow={flow} />
          <label htmlFor="email" className="font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            defaultValue={sendState.email}
            aria-invalid={!!sendState.error}
            className={input}
          />
          <button type="submit" disabled={sending} className={button}>
            {sending ? 'Sending…' : 'Email me a sign-in code'}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <form action={verify} className="flex flex-col gap-3" noValidate>
            <FlowFields flow={flow} />
            <input type="hidden" name="email" value={sendState.email} />
            <label htmlFor="code" className="font-medium">
              6-digit code
            </label>
            <input
              ref={codeRef}
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              aria-invalid={!!verifyState.error}
              aria-describedby="code-help"
              className={`${input} tracking-[0.4em]`}
            />
            <p id="code-help" className="text-sm text-[var(--color-ink-muted)]">
              Or open the link in the email on this device.
            </p>
            <button type="submit" disabled={verifying} className={button}>
              {verifying ? 'Checking…' : 'Sign in'}
            </button>
          </form>
          <div className="flex flex-wrap items-center gap-4">
            <form action={send}>
              <FlowFields flow={flow} />
              <input type="hidden" name="email" value={sendState.email} />
              <button
                type="submit"
                disabled={sending || cooldown > 0}
                className="min-h-11 underline-offset-4 hover:underline disabled:text-[var(--color-ink-muted)] disabled:no-underline"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setEditingEmail(true)}
              className="min-h-11 underline-offset-4 hover:underline"
            >
              Use a different email
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
