'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Rate-limits text for an `aria-live` region: screen readers get at most one update per
 * `intervalMs` (the latest message wins), so per-byte progress never floods announcements.
 */
export function useThrottledAnnouncement(message: string, intervalMs = 3000): string {
  const [announced, setAnnounced] = useState(message);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (message === announced) return;
    const wait = lastAt.current + intervalMs - Date.now();
    if (timer.current) clearTimeout(timer.current);
    const publish = () => {
      lastAt.current = Date.now();
      timer.current = null;
      setAnnounced(message);
    };
    if (wait <= 0) publish();
    else timer.current = setTimeout(publish, wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message, announced, intervalMs]);

  return announced;
}
