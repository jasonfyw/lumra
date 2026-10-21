import { GUEST_LIMITS } from '@lumra/config';

export interface GuestUsage {
  reservedFileCount: number;
  reservedBytes: number;
}

export type GuestReservationDecision =
  { allowed: true } | { allowed: false; reason: 'file_count' | 'bytes' | 'single_file_too_large' };

/**
 * Pure pre-check for a guest upload reservation (FR-A02). The authoritative check runs again
 * inside an atomic conditional UPDATE in the database (T06); this keeps both in sync.
 */
export function checkGuestReservation(
  usage: GuestUsage,
  fileBytes: number,
): GuestReservationDecision {
  if (fileBytes > GUEST_LIMITS.maxBytes) return { allowed: false, reason: 'single_file_too_large' };
  if (usage.reservedFileCount + 1 > GUEST_LIMITS.maxFiles)
    return { allowed: false, reason: 'file_count' };
  if (usage.reservedBytes + fileBytes > GUEST_LIMITS.maxBytes)
    return { allowed: false, reason: 'bytes' };
  return { allowed: true };
}
