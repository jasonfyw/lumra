/**
 * Status sets persisted as Postgres enums (infra/supabase/migrations). Sets that are part of the
 * API or domain state machines are re-exported from their owning package so there is one source
 * of truth; the remaining sets are database-level and owned here. `schema.test.ts` asserts every
 * set matches the `create type ... as enum` statements in the migrations.
 */
import { GALLERY_STATUSES, MEDIA_STATUSES } from '@lumra/contracts';
import { ARCHIVE_STATUSES } from '@lumra/domain';

export { ARCHIVE_STATUSES, GALLERY_STATUSES, MEDIA_STATUSES };

export const UPLOAD_SESSION_STATUSES = ['pending', 'completed', 'aborted', 'expired'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

/** PRD §7 billing account state machine (no trial in v1). */
export const BILLING_ACCOUNT_STATUSES = [
  'free',
  'active',
  'past_due',
  'restricted',
  'canceled',
] as const;
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number];

export const BILLING_EXPORT_STATUSES = ['pending', 'sent', 'failed'] as const;
export type BillingExportStatus = (typeof BILLING_EXPORT_STATUSES)[number];

/** FR-N02: item and archive downloads are distinguished in the backend. */
export const GALLERY_EVENT_TYPES = ['view', 'item_download', 'archive_download'] as const;
export type GalleryEventType = (typeof GALLERY_EVENT_TYPES)[number];

/** Metered quantities in `usage_ledger` (raw integers; unit is byte_seconds or bytes). */
export const USAGE_METRICS = ['storage_byte_seconds', 'delivery_bytes'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export const USAGE_METRIC_UNITS = {
  storage_byte_seconds: 'byte_seconds',
  delivery_bytes: 'bytes',
} as const satisfies Record<UsageMetric, string>;
export type UsageUnit = (typeof USAGE_METRIC_UNITS)[UsageMetric];

export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'failed', 'ignored'] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

/** Postgres enum type name -> TypeScript value set. */
export const DB_ENUMS = {
  gallery_status: GALLERY_STATUSES,
  media_status: MEDIA_STATUSES,
  archive_status: ARCHIVE_STATUSES,
  upload_session_status: UPLOAD_SESSION_STATUSES,
  billing_account_status: BILLING_ACCOUNT_STATUSES,
  billing_export_status: BILLING_EXPORT_STATUSES,
  gallery_event_type: GALLERY_EVENT_TYPES,
  usage_metric: USAGE_METRICS,
  webhook_event_status: WEBHOOK_EVENT_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>;
