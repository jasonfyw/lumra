'use client';

import { useId, useState } from 'react';
import {
  USER_NAME_MAX_LENGTH,
  type ApiResponse,
  type UpdateAccountResponse,
} from '@lumra/contracts';
import { buttonClass } from '@/components/ui';

/**
 * Display name field on `/account`. Shown in the browser-tab title of the owner's public
 * galleries. Optional: clearing the field removes it. The server trims and validates again.
 */
export function NameForm({ initialName }: { initialName: string | null }) {
  const id = useId();
  const [value, setValue] = useState(initialName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim().length > USER_NAME_MAX_LENGTH) {
      setError(`Use ${USER_NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/v1/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });
      const body = (await res.json()) as ApiResponse<UpdateAccountResponse>;
      if (body.error) {
        setError(body.error.message);
        return;
      }
      setValue(body.data.name ?? '');
      setSaved(true);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
      <div className="lm-field max-w-xs">
        <label htmlFor={`${id}-name`} className="lm-field-label">
          Name
        </label>
        <input
          id={`${id}-name`}
          autoComplete="name"
          maxLength={USER_NAME_MAX_LENGTH * 2}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? true : undefined}
          className="lm-input"
        />
        <p id={`${id}-hint`} className="lm-field-hint">
          Optional. Shown in the tab title of your shared galleries.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'md', 'min-h-11')}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
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
    </form>
  );
}
