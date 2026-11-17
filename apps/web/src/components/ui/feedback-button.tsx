'use client';

import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './index';

export const FEEDBACK_MS = 2000;

/**
 * A boolean that turns on when `flash()` is called and turns itself off after `ms`. Calling
 * `flash()` again restarts the timer. Cleans up on unmount.
 */
export function useTransientFlag(ms = FEEDBACK_MS): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const reset = useCallback(() => {
    clear();
    setOn(false);
  }, [clear]);
  const flash = useCallback(() => {
    clear();
    setOn(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setOn(false);
    }, ms);
  }, [clear, ms]);
  useEffect(() => clear, [clear]);
  return [on, flash, reset];
}

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/**
 * Button whose label briefly turns into a confirmation ("Copy link" → "Copied" with a check)
 * after an action succeeds. Both labels share one grid cell, so the button never changes width
 * (no layout jump) and the swap is a short cross-fade (none under `prefers-reduced-motion`).
 * Screen readers get a polite announcement (`announcement`, defaulting to `doneLabel`).
 */
export function FeedbackButton({
  label,
  doneLabel,
  icon,
  done,
  announcement,
  className,
  type = 'button',
  ...rest
}: NativeButtonProps & {
  label: string;
  doneLabel: string;
  icon: IconName;
  /** True while the confirmation is showing (drive with `useTransientFlag`). */
  done: boolean;
  announcement?: string;
}) {
  return (
    <>
      <button type={type} className={className} data-done={done || undefined} {...rest}>
        <span className="lm-swap lm-swap-icon" aria-hidden="true">
          <Icon name={icon} size={16} data-swap={done ? 'out' : 'in'} />
          <Icon name="check" size={16} data-swap={done ? 'in' : 'out'} />
        </span>
        <span className="lm-swap">
          <span data-swap={done ? 'out' : 'in'} aria-hidden={done || undefined}>
            {label}
          </span>
          <span data-swap={done ? 'in' : 'out'} aria-hidden={!done || undefined}>
            {doneLabel}
          </span>
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {done ? (announcement ?? doneLabel) : ''}
      </span>
    </>
  );
}
