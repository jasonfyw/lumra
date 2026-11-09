/**
 * Drizzle mirror of the SQL-first schema in infra/supabase/migrations (ADR-007).
 * The migrations are authoritative: Drizzle is used only as a typed query builder and never
 * generates or applies migrations. Keep this file in sync whenever a migration changes a table.
 * CHECK constraints, partial indexes, triggers and RLS live only in SQL.
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ARCHIVE_STATUSES,
  BILLING_ACCOUNT_STATUSES,
  BILLING_EXPORT_STATUSES,
  GALLERY_EVENT_TYPES,
  GALLERY_STATUSES,
  MEDIA_STATUSES,
  UPLOAD_SESSION_STATUSES,
  USAGE_METRICS,
  WEBHOOK_EVENT_STATUSES,
  type UsageUnit,
} from './enums';
import type { PlanId } from '@lumra/config';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** BIGINT as a JS number: bytes and micro-USD stay far below 2^53. */
const int8 = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const id = () => uuid('id').primaryKey().defaultRandom();

// ---------------------------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------------------------

export const galleryStatus = pgEnum('gallery_status', GALLERY_STATUSES);
export const mediaStatus = pgEnum('media_status', MEDIA_STATUSES);
export const archiveStatus = pgEnum('archive_status', ARCHIVE_STATUSES);
export const uploadSessionStatus = pgEnum('upload_session_status', UPLOAD_SESSION_STATUSES);
export const billingAccountStatus = pgEnum('billing_account_status', BILLING_ACCOUNT_STATUSES);
export const billingExportStatus = pgEnum('billing_export_status', BILLING_EXPORT_STATUSES);
export const galleryEventType = pgEnum('gallery_event_type', GALLERY_EVENT_TYPES);
export const usageMetric = pgEnum('usage_metric', USAGE_METRICS);
export const webhookEventStatus = pgEnum('webhook_event_status', WEBHOOK_EVENT_STATUSES);

// ---------------------------------------------------------------------------------------------
// auth schema (managed by Supabase Auth; only referenced, never written by the app)
// ---------------------------------------------------------------------------------------------

const auth = pgSchema('auth');
export const authUsers = auth.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email'),
});

// ---------------------------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------------------------

/** One row per PlanRates (@lumra/config rate-card.ts); `id` is the PlanId. */
export const plans = pgTable('plans', {
  id: text('id').$type<PlanId>().primaryKey(),
  rateVersion: integer('rate_version').notNull(),
  monthlyFeeMicroUsd: int8('monthly_fee_micro_usd').notNull(),
  maxActiveGalleries: integer('max_active_galleries'),
  maxStorageBytes: int8('max_storage_bytes'),
  maxDeliveryBytesPerMonth: int8('max_delivery_bytes_per_month'),
  includedStorageGbMonth: integer('included_storage_gb_month').notNull(),
  includedDeliveryGb: integer('included_delivery_gb').notNull(),
  storageOverageMicroUsdPerGbMonth: int8('storage_overage_micro_usd_per_gb_month'),
  deliveryOverageMicroUsdPerGb: int8('delivery_overage_micro_usd_per_gb'),
  defaultOverageCapMicroUsd: int8('default_overage_cap_micro_usd'),
  brandingVisible: boolean('branding_visible').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Immutable, versioned rate card (T27). `plans` points at the current version and its rate
 * columns are a trigger-maintained projection of that row. Only `decision`/`notes` may change.
 */
export const RATE_VERSION_DECISIONS = ['proposed', 'confirmed'] as const;
export type RateVersionDecision = (typeof RATE_VERSION_DECISIONS)[number];

export const planRateVersions = pgTable(
  'plan_rate_versions',
  {
    planId: text('plan_id')
      .$type<PlanId>()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    rateVersion: integer('rate_version').notNull(),
    monthlyFeeMicroUsd: int8('monthly_fee_micro_usd').notNull(),
    maxActiveGalleries: integer('max_active_galleries'),
    maxStorageBytes: int8('max_storage_bytes'),
    maxDeliveryBytesPerMonth: int8('max_delivery_bytes_per_month'),
    includedStorageGbMonth: integer('included_storage_gb_month').notNull(),
    includedDeliveryGb: integer('included_delivery_gb').notNull(),
    storageOverageMicroUsdPerGbMonth: int8('storage_overage_micro_usd_per_gb_month'),
    deliveryOverageMicroUsdPerGb: int8('delivery_overage_micro_usd_per_gb'),
    defaultOverageCapMicroUsd: int8('default_overage_cap_micro_usd'),
    brandingVisible: boolean('branding_visible').notNull(),
    decision: text('decision').$type<RateVersionDecision>().notNull().default('proposed'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'plan_rate_versions_pkey', columns: [t.planId, t.rateVersion] })],
);

export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  displayName: text('display_name'),
  planId: text('plan_id')
    .$type<PlanId>()
    .notNull()
    .default('free')
    .references(() => plans.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const billingAccounts = pgTable('billing_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  status: billingAccountStatus('status').notNull().default('free'),
  spendCapMicroUsd: int8('spend_cap_micro_usd'),
  warningThresholds: smallint('warning_thresholds').array().notNull().default([50, 80, 100]),
  billingPeriodStart: tstz('billing_period_start'),
  billingPeriodEnd: tstz('billing_period_end'),
  pastDueSince: tstz('past_due_since'),
  restrictedSince: tstz('restricted_since'),
  canceledAt: tstz('canceled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const guestSessions = pgTable('guest_sessions', {
  id: id(),
  capabilityHash: text('capability_hash').notNull().unique(),
  expiresAt: tstz('expires_at').notNull(),
  claimedByUserId: uuid('claimed_by_user_id').references(() => authUsers.id, {
    onDelete: 'set null',
  }),
  claimedAt: tstz('claimed_at'),
  reservedFileCount: integer('reserved_file_count').notNull().default(0),
  reservedBytes: int8('reserved_bytes').notNull().default(0),
  rateKeyHash: text('rate_key_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const galleries = pgTable('galleries', {
  id: id(),
  ownerId: uuid('owner_id').references(() => authUsers.id, { onDelete: 'restrict' }),
  guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, {
    onDelete: 'set null',
  }),
  claimedAt: tstz('claimed_at'),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull().default('Untitled gallery'),
  status: galleryStatus('status').notNull().default('draft'),
  passwordHash: text('password_hash'),
  accessVersion: integer('access_version').notNull().default(1),
  coverMediaId: uuid('cover_media_id').references((): AnyPgColumn => media.id, {
    onDelete: 'set null',
  }),
  expiresAt: tstz('expires_at'),
  publishedAt: tstz('published_at'),
  contentVersion: integer('content_version').notNull().default(1),
  deletedAt: tstz('deleted_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const media = pgTable('media', {
  id: id(),
  galleryId: uuid('gallery_id')
    .notNull()
    .references(() => galleries.id, { onDelete: 'cascade' }),
  originalKey: text('original_key').notNull().unique(),
  filename: text('filename').notNull(),
  mime: text('mime').$type<'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic'>().notNull(),
  byteSize: int8('byte_size').notNull(),
  width: integer('width'),
  height: integer('height'),
  /** EXIF orientation (1–8) of the original; derivatives are already rotated (T12). */
  orientation: smallint('orientation'),
  takenAt: tstz('taken_at'),
  /** Fractional ordering key; column collation is "C" (byte-wise). */
  sortKey: text('sort_key').notNull(),
  status: mediaStatus('status').notNull().default('reserved'),
  uploadSessionId: uuid('upload_session_id').references((): AnyPgColumn => uploadSessions.id, {
    onDelete: 'set null',
  }),
  readyAt: tstz('ready_at'),
  failureCode: text('failure_code'),
  /** Client-declared SHA-256 (hex), verified by the image worker (T10, docs/UPLOADS.md). */
  checksumSha256: text('checksum_sha256'),
  deletedAt: tstz('deleted_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mediaVariants = pgTable(
  'media_variants',
  {
    id: id(),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),
    objectKey: text('object_key').notNull().unique(),
    mime: text('mime').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    byteSize: int8('byte_size').notNull(),
    readyAt: tstz('ready_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('media_variants_media_variant_key').on(t.mediaId, t.variant)],
);

export const uploadSessions = pgTable('upload_sessions', {
  id: id(),
  galleryId: uuid('gallery_id')
    .notNull()
    .references(() => galleries.id, { onDelete: 'cascade' }),
  mediaId: uuid('media_id')
    .notNull()
    .references(() => media.id, { onDelete: 'cascade' }),
  providerUploadId: text('provider_upload_id'),
  partSize: integer('part_size').notNull(),
  reservedBytes: int8('reserved_bytes').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  status: uploadSessionStatus('status').notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  completedAt: tstz('completed_at'),
  /** Guest quota holding this reservation; null when admitted against an account plan. */
  guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const archiveJobs = pgTable('archive_jobs', {
  id: id(),
  galleryId: uuid('gallery_id')
    .notNull()
    .references(() => galleries.id, { onDelete: 'cascade' }),
  requestedBySessionHash: text('requested_by_session_hash').notNull(),
  contentVersion: integer('content_version').notNull(),
  status: archiveStatus('status').notNull().default('requested'),
  partsExpected: integer('parts_expected'),
  progressPct: smallint('progress_pct').notNull().default(0),
  expiresAt: tstz('expires_at'),
  failureCode: text('failure_code'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const archiveParts = pgTable(
  'archive_parts',
  {
    id: id(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => archiveJobs.id, { onDelete: 'cascade' }),
    partNo: integer('part_no').notNull(),
    objectKey: text('object_key').notNull().unique(),
    byteSize: int8('byte_size'),
    checksumSha256: text('checksum_sha256'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('archive_parts_job_part_key').on(t.jobId, t.partNo)],
);

export const galleryAccessSessions = pgTable('gallery_access_sessions', {
  id: id(),
  galleryId: uuid('gallery_id')
    .notNull()
    .references(() => galleries.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  accessVersion: integer('access_version').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  createdAt: createdAt(),
});

export const galleryEvents = pgTable('gallery_events', {
  id: id(),
  galleryId: uuid('gallery_id')
    .notNull()
    .references(() => galleries.id, { onDelete: 'cascade' }),
  eventType: galleryEventType('event_type').notNull(),
  mediaId: uuid('media_id').references(() => media.id, { onDelete: 'set null' }),
  anonymousSessionHash: text('anonymous_session_hash').notNull(),
  /** floor(epoch_seconds / 1800): 30-minute view dedupe window (FR-N02). */
  windowBucket: int8('window_bucket').notNull(),
  bytesServed: int8('bytes_served').notNull().default(0),
  idempotencyKey: text('idempotency_key').unique(),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  createdAt: createdAt(),
});

/** Append-only (UPDATE/DELETE rejected by trigger); corrections are compensating rows. */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => billingAccounts.userId, { onDelete: 'restrict' }),
    metric: usageMetric('metric').notNull(),
    /** Raw integer quantity in `unit` (byte-seconds or bytes). */
    quantityMicroUnits: int8('quantity_micro_units').notNull(),
    unit: text('unit').$type<UsageUnit>().notNull(),
    sourceId: text('source_id').notNull(),
    eventTime: tstz('event_time').notNull(),
    periodStart: tstz('period_start').notNull(),
    ratingVersion: integer('rating_version').notNull(),
    estimatedCostMicroUsd: int8('estimated_cost_micro_usd').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique('usage_ledger_metric_source_key').on(t.metric, t.sourceId)],
);

/** Storage accrual job cursor per account (T27): accrued up to `accruedThrough`. */
export const storageAccrualCursors = pgTable('storage_accrual_cursors', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => billingAccounts.userId, { onDelete: 'cascade' }),
  accruedThrough: tstz('accrued_through').notNull(),
  storedBytes: int8('stored_bytes').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const billingExports = pgTable('billing_exports', {
  id: id(),
  billingAccountId: uuid('billing_account_id')
    .notNull()
    .references(() => billingAccounts.userId, { onDelete: 'restrict' }),
  ledgerCursor: text('ledger_cursor').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  stripeEventId: text('stripe_event_id').unique(),
  status: billingExportStatus('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const jobOutbox = pgTable('job_outbox', {
  id: id(),
  eventName: text('event_name').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text('dedupe_key').unique(),
  availableAt: tstz('available_at').notNull().defaultNow(),
  processedAt: tstz('processed_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const providerWebhookEvents = pgTable(
  'provider_webhook_events',
  {
    id: id(),
    provider: text('provider').$type<'stripe'>().notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type'),
    status: webhookEventStatus('status').notNull().default('received'),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    handledAt: tstz('handled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('provider_webhook_events_provider_event_key').on(t.provider, t.providerEventId)],
);

/** Sliding-window rate limiter counters (FR-A05). Keys are HMACs; never raw IPs or ids. */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').notNull(),
    windowStart: tstz('window_start').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'rate_limit_buckets_pkey', columns: [t.bucketKey, t.windowStart] })],
);

// ---------------------------------------------------------------------------------------------
// inferred row types
// ---------------------------------------------------------------------------------------------

export type Plan = typeof plans.$inferSelect;
export type PlanRateVersion = typeof planRateVersions.$inferSelect;
export type StorageAccrualCursorRow = typeof storageAccrualCursors.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type BillingAccount = typeof billingAccounts.$inferSelect;
export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;
export type Gallery = typeof galleries.$inferSelect;
export type NewGallery = typeof galleries.$inferInsert;
export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type MediaVariant = typeof mediaVariants.$inferSelect;
export type NewMediaVariant = typeof mediaVariants.$inferInsert;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewUploadSession = typeof uploadSessions.$inferInsert;
export type ArchiveJob = typeof archiveJobs.$inferSelect;
export type NewArchiveJob = typeof archiveJobs.$inferInsert;
export type ArchivePart = typeof archiveParts.$inferSelect;
export type NewArchivePart = typeof archiveParts.$inferInsert;
export type GalleryAccessSession = typeof galleryAccessSessions.$inferSelect;
export type NewGalleryAccessSession = typeof galleryAccessSessions.$inferInsert;
export type GalleryEvent = typeof galleryEvents.$inferSelect;
export type NewGalleryEvent = typeof galleryEvents.$inferInsert;
export type UsageLedgerEntry = typeof usageLedger.$inferSelect;
export type NewUsageLedgerEntry = typeof usageLedger.$inferInsert;
export type BillingExport = typeof billingExports.$inferSelect;
export type NewBillingExport = typeof billingExports.$inferInsert;
export type JobOutboxEntry = typeof jobOutbox.$inferSelect;
export type NewJobOutboxEntry = typeof jobOutbox.$inferInsert;
export type ProviderWebhookEvent = typeof providerWebhookEvents.$inferSelect;
export type NewProviderWebhookEvent = typeof providerWebhookEvents.$inferInsert;
