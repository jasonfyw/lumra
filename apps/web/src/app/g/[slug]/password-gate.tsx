'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Icon, buttonClass } from '@/components/ui';

interface ErrorBody {
  error?: { code?: string; details?: { retryAfterSeconds?: unknown; challenge?: unknown } };
}

/** Recipient-facing message for an unlock failure; never echoes server internals. */
export function unlockErrorMessage(status: number, body: ErrorBody | null): string {
  const code = body?.error?.code;
  if (code === 'invalid_password') return 'That password is not correct. Please try again.';
  if (code === 'rate_limited') {
    if (body?.error?.details?.challenge) {
      return 'Too many attempts from this network. Please wait a few minutes and try again.';
    }
    const seconds = Number(body?.error?.details?.retryAfterSeconds);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
    return minutes
      ? `Too many attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`
      : 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (code === 'validation_failed') return 'Please enter the gallery password.';
  if (status === 404 || status === 410) return 'This gallery is no longer available.';
  return 'Something went wrong. Please try again.';
}

/** Password gate for protected galleries (FR-G04, T19). */
export function PasswordGate({ slug }: { slug: string }) {
  const router = useRouter();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!password) {
      setError('Please enter the gallery password.');
      inputRef.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/public/galleries/${encodeURIComponent(slug)}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
      });
      if (res.ok) {
        setPassword('');
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as ErrorBody | null;
      setError(unlockErrorMessage(res.status, body));
      if (res.status === 404 || res.status === 410) router.refresh();
      inputRef.current?.select();
    } catch {
      setError('Could not reach Lumra. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="lm-gate">
      <div className="lm-gate-icon">
        <Icon name="lock" size={24} />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1 className="lm-title-display-sm">This gallery is password protected</h1>
        <p className="lm-gate-body">Enter the password you were given to view the photos.</p>
      </div>
      <form
        onSubmit={onSubmit}
        noValidate
        className="flex w-full max-w-[340px] flex-col gap-3 text-left"
      >
        <div className="lm-field">
          <label htmlFor={inputId} className="lm-field-label">
            Password
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            maxLength={256}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="lm-input"
          />
          <p id={errorId} role="alert" aria-live="polite" className="lm-field-error min-h-[18px]">
            {error ?? ''}
          </p>
        </div>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'lg', 'w-full')}>
          {pending ? 'Checking…' : 'View gallery'}
        </button>
      </form>
    </main>
  );
}
