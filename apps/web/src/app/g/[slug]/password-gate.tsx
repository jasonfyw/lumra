'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';

const button =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 font-medium text-white disabled:opacity-60';
const input =
  'min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-white px-3 text-base';

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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">
          This gallery is password protected
        </h1>
        <p className="text-[var(--color-ink-muted)]">
          Enter the password you were given to view the photos.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <label htmlFor={inputId} className="text-sm font-medium">
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
          className={input}
        />
        <p id={errorId} role="alert" aria-live="polite" className="min-h-5 text-sm text-red-700">
          {error ?? ''}
        </p>
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Checking…' : 'View gallery'}
        </button>
      </form>
    </main>
  );
}
