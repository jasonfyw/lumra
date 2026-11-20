'use client';

import { useSyncExternalStore } from 'react';
import {
  formatDateLocal,
  formatDateTimeLocal,
  formatDateTimeUtc,
  formatDateUtc,
} from '@/lib/format';

const subscribe = () => () => undefined;

/** False during SSR and the hydration pass, true afterwards: no mismatch, no effect-driven flash. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * Renders an ISO instant in the viewer's time zone. Server components cannot know it, so the
 * server (and hydration) render is a stable UTC string; right after hydration it switches to the
 * browser's zone. `dateTime` always carries the full ISO and the tooltip the absolute time.
 */
export function LocalTime({
  value,
  format = 'date',
  className,
}: {
  value: string;
  format?: 'date' | 'datetime';
  className?: string;
}) {
  const hydrated = useHydrated();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <time className={className}>{value}</time>;
  const utc = format === 'date' ? formatDateUtc(value) : `${formatDateTimeUtc(value)} UTC`;
  const local = format === 'date' ? formatDateLocal(value) : formatDateTimeLocal(value);
  const title = hydrated ? formatDateTimeLocal(value, true) : `${formatDateTimeUtc(value)} UTC`;
  return (
    <time
      dateTime={date.toISOString()}
      title={title}
      className={className}
      suppressHydrationWarning
    >
      {hydrated ? local : utc}
    </time>
  );
}
