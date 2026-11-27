'use client';

import posthog from 'posthog-js';

const posthogEnabled = Boolean(
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST,
);

export function capturePostHogEvent(event: string, properties?: Record<string, unknown>) {
  if (!posthogEnabled) return;
  posthog.capture(event, properties);
}

export function capturePostHogException(error: unknown) {
  if (!posthogEnabled) return;
  posthog.captureException(error);
}
