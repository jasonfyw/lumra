const UNIQUE_VIOLATION = '23505';

/** Attempts per gallery creation: 8-char slugs collide rarely (ADR-010), 3 tries is ample. */
export const MAX_SLUG_ATTEMPTS = 3;

/** Postgres `unique_violation`, as thrown directly or wrapped (`cause`) by the driver/Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (
    (error as { code?: string })?.code === UNIQUE_VIOLATION || cause?.code === UNIQUE_VIOLATION
  );
}

/**
 * Runs `attempt` (which must generate a fresh slug and use its own transaction, since a unique
 * violation aborts the surrounding one) and retries on a unique violation, e.g. a slug collision.
 */
export async function withSlugRetry<T>(
  attempt: () => Promise<T>,
  maxAttempts: number = MAX_SLUG_ATTEMPTS,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (n < maxAttempts && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}
