/**
 * SERVER-ONLY. Postgres adapters for the `@lumra/billing` ports (T27, ADR-004) plus the reads and
 * writes the metering job needs (storage accrual; delivery is not metered, ADR-008). Raw SQL over
 * postgres.js like the other worker repositories; money and quantities cross the wire as text and are parsed
 * into integers here, so nothing passes through floating point.
 *
 * DB ↔ TS vocabulary: `usage_ledger.unit` is `byte_seconds` in SQL and `byte_second` in
 * `@lumra/billing`; `quantity_micro_units` is the raw integer quantity.
 */
import type postgres from 'postgres';
import {
  type BillingAccountStore,
  type CostReservationStore,
  type EmailNotice,
  type SafeguardStore,
  type LedgerEntry,
  type PlanStore,
  type Reservation,
  type StorageAccrualCursor,
  type StoredBillingPeriod,
  type UsageLedgerStore,
  type UsageMetric,
  type UsageUnit as BillingUsageUnit,
  billingPeriodAt,
  estimateStoredFootprintBytes,
  ledgerIdempotencyKey,
} from '@lumra/billing';
import type { PlanId, PlanRates } from '@lumra/config';
import { pgArray } from '../client';
import { USAGE_METRIC_UNITS, type BillingAccountStatus, type UsageUnit } from '../enums';

const DB_UNIT: Record<BillingUsageUnit, UsageUnit> = {
  byte_second: 'byte_seconds',
};
const BILLING_UNIT: Record<UsageUnit, BillingUsageUnit> = {
  byte_seconds: 'byte_second',
};

export class RateVersionNotFoundError extends Error {
  constructor(planId: string, rateVersion: number | null) {
    super(`No rate card for plan ${planId}${rateVersion === null ? '' : ` v${rateVersion}`}`);
    this.name = 'RateVersionNotFoundError';
  }
}

/** Columns shared by `plans` and `plan_rate_versions` (Drizzle or raw rows). */
export interface PlanRatesRow {
  id?: string;
  planId?: string;
  rateVersion: number;
  monthlyFeeMicroUsd: number;
  maxActiveGalleries: number | null;
  maxStorageBytes: number | null;
  includedStorageGbMonth: number;
  storageOverageMicroUsdPerGbMonth: number | null;
  defaultOverageCapMicroUsd: number | null;
  brandingVisible: boolean;
}

/** Maps a `plans` / `plan_rate_versions` row to `PlanRates`. */
export function planRatesFromRow(row: PlanRatesRow): PlanRates {
  const id = (row.id ?? row.planId) as PlanId | undefined;
  if (id !== 'free' && id !== 'pro') throw new Error('plan row has no valid id');
  return {
    id,
    rateVersion: row.rateVersion,
    monthlyFeeMicroUsd: row.monthlyFeeMicroUsd,
    maxActiveGalleries: row.maxActiveGalleries,
    maxStorageBytes: row.maxStorageBytes,
    includedStorageGbMonth: row.includedStorageGbMonth,
    storageOverageMicroUsdPerGbMonth: row.storageOverageMicroUsdPerGbMonth,
    defaultOverageCapMicroUsd: row.defaultOverageCapMicroUsd,
    brandingVisible: row.brandingVisible,
  };
}

// ---------------------------------------------------------------------------------------------
// raw row helpers
// ---------------------------------------------------------------------------------------------

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Date | string | null): Date | null =>
  value === null ? null : toDate(value);

/** BIGINT text → safe-integer number, refusing silent precision loss. */
function toInt(value: string | number | null, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} is not a safe integer`);
  return n;
}
const toIntOrNull = (value: string | number | null, label: string): number | null =>
  value === null ? null : toInt(value, label);

/** Rate columns selected as text from `plan_rate_versions` aliased `pv`. */
interface RateColumns {
  plan_id: string;
  rate_version: number;
  monthly_fee_micro_usd: string;
  max_active_galleries: number | null;
  max_storage_bytes: string | null;
  included_storage_gb_month: number;
  storage_overage_micro_usd_per_gb_month: string | null;
  default_overage_cap_micro_usd: string | null;
  branding_visible: boolean;
}

function ratesFromColumns(r: RateColumns): PlanRates {
  return planRatesFromRow({
    planId: r.plan_id,
    rateVersion: r.rate_version,
    monthlyFeeMicroUsd: toInt(r.monthly_fee_micro_usd, 'monthly_fee_micro_usd'),
    maxActiveGalleries: r.max_active_galleries,
    maxStorageBytes: toIntOrNull(r.max_storage_bytes, 'max_storage_bytes'),
    includedStorageGbMonth: r.included_storage_gb_month,
    storageOverageMicroUsdPerGbMonth: toIntOrNull(
      r.storage_overage_micro_usd_per_gb_month,
      'storage_overage_micro_usd_per_gb_month',
    ),
    defaultOverageCapMicroUsd: toIntOrNull(
      r.default_overage_cap_micro_usd,
      'default_overage_cap_micro_usd',
    ),
    brandingVisible: r.branding_visible,
  });
}

function rateColumns(sql: postgres.Sql) {
  return sql`
    pv.plan_id, pv.rate_version,
    pv.monthly_fee_micro_usd::text as monthly_fee_micro_usd,
    pv.max_active_galleries,
    pv.max_storage_bytes::text as max_storage_bytes,
    pv.included_storage_gb_month,
    pv.storage_overage_micro_usd_per_gb_month::text as storage_overage_micro_usd_per_gb_month,
    pv.default_overage_cap_micro_usd::text as default_overage_cap_micro_usd,
    pv.branding_visible`;
}

interface LedgerRow {
  account_id: string;
  metric: UsageMetric;
  quantity: string;
  unit: UsageUnit;
  source_id: string;
  event_time: Date | string;
  period_start: Date | string;
  rating_version: number;
  estimated_cost: string;
}

function ledgerEntryFromRow(r: LedgerRow): LedgerEntry {
  return {
    idempotencyKey: ledgerIdempotencyKey(r.metric, r.source_id),
    accountId: r.account_id,
    metric: r.metric,
    quantity: BigInt(r.quantity),
    unit: BILLING_UNIT[r.unit],
    sourceId: r.source_id,
    eventTime: toDate(r.event_time),
    periodStart: toDate(r.period_start),
    rateVersion: r.rating_version,
    estimatedCostMicroUsd: toInt(r.estimated_cost, 'estimated_cost_micro_usd'),
  };
}

/** JSON payload for one ledger row; quantities as decimal strings (exact for any bigint). */
function ledgerJson(e: LedgerEntry) {
  if (USAGE_METRIC_UNITS[e.metric] !== DB_UNIT[e.unit]) {
    throw new Error(`ledger unit ${e.unit} does not match metric ${e.metric}`);
  }
  return {
    account_id: e.accountId,
    metric: e.metric,
    quantity: e.quantity.toString(),
    unit: DB_UNIT[e.unit],
    source_id: e.sourceId,
    event_time: e.eventTime.toISOString(),
    period_start: e.periodStart.toISOString(),
    rating_version: e.rateVersion,
    estimated_cost: String(e.estimatedCostMicroUsd),
  };
}

/** One INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT DO NOTHING; returns new rows. */
async function insertLedger(
  sql: postgres.Sql | postgres.TransactionSql,
  entries: readonly LedgerEntry[],
): Promise<number> {
  const unique = new Map<string, LedgerEntry>();
  for (const e of entries) if (!unique.has(e.idempotencyKey)) unique.set(e.idempotencyKey, e);
  if (unique.size === 0) return 0;
  const payload = JSON.stringify([...unique.values()].map(ledgerJson));
  const rows = await sql<{ id: string }[]>`
    insert into public.usage_ledger (
      account_id, metric, quantity_micro_units, unit, source_id, event_time, period_start,
      rating_version, estimated_cost_micro_usd
    )
    select r.account_id, r.metric::public.usage_metric, r.quantity::bigint, r.unit, r.source_id,
           r.event_time, r.period_start, r.rating_version, r.estimated_cost::bigint
    from jsonb_to_recordset(${payload}::text::jsonb) as r(
      account_id uuid, metric text, quantity text, unit text, source_id text,
      event_time timestamptz, period_start timestamptz, rating_version integer,
      estimated_cost text
    )
    on conflict on constraint usage_ledger_metric_source_key do nothing
    returning id`;
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// metering-specific shapes
// ---------------------------------------------------------------------------------------------

export interface AccountBillingContext {
  accountId: string;
  account: StoredBillingPeriod;
  /** The account's *current* plan rates. */
  plan: PlanRates;
}

export interface StorageAccrualCandidate extends AccountBillingContext {
  cursor: StorageAccrualCursor | null;
  /** Originals (uploaded/processing/ready) + derivatives in non-deleted galleries, as `/account`. */
  storedBytesNow: number;
}

export interface BillingRepository {
  plans: PlanStore;
  ledger: UsageLedgerStore;
  accounts: BillingAccountStore;
  reservations: CostReservationStore;

  /** Accounts whose storage cursor is missing or older than `windowEnd`, stalest first. */
  storageAccrualCandidates(windowEnd: Date, limit: number): Promise<StorageAccrualCandidate[]>;
  storageByteSecondsToDate(accountId: string, periodStart: Date): Promise<bigint>;
  /**
   * Atomically appends the accrual rows and moves the cursor from `expected` (`null` = no
   * cursor yet) to `next`. Returns false — writing nothing — if another run moved it first.
   */
  commitStorageAccrual(
    accountId: string,
    expected: Date | null,
    entries: readonly LedgerEntry[],
    next: StorageAccrualCursor,
  ): Promise<boolean>;
}

interface AccountContextRow extends RateColumns {
  account_id: string;
  billing_period_start: Date | string | null;
  billing_period_end: Date | string | null;
}

function contextFromRow(r: AccountContextRow): AccountBillingContext {
  return {
    accountId: r.account_id,
    account: {
      billingPeriodStart: toDateOrNull(r.billing_period_start),
      billingPeriodEnd: toDateOrNull(r.billing_period_end),
    },
    plan: ratesFromColumns(r),
  };
}

export function createBillingRepository(sql: postgres.Sql): BillingRepository {
  // Billing account + current plan version (profiles.plan_id → plans.rate_version → pv).
  // Fragments are built per query (postgres.js fragments are cheap and not shared).
  const accountContextFrom = () => sql`
    from public.billing_accounts ba
    left join public.profiles p on p.user_id = ba.user_id
    join public.plans pl on pl.id = coalesce(p.plan_id, 'free')
    join public.plan_rate_versions pv
      on pv.plan_id = pl.id and pv.rate_version = pl.rate_version`;

  const plans: PlanStore = {
    async getRates(planId, rateVersion) {
      const [row] = await sql<RateColumns[]>`
        select ${rateColumns(sql)} from public.plan_rate_versions pv
        where pv.plan_id = ${planId} and pv.rate_version = ${rateVersion}`;
      if (!row) throw new RateVersionNotFoundError(planId, rateVersion);
      return ratesFromColumns(row);
    },
    async getCurrent(planId) {
      const [row] = await sql<RateColumns[]>`
        select ${rateColumns(sql)} from public.plans pl
        join public.plan_rate_versions pv
          on pv.plan_id = pl.id and pv.rate_version = pl.rate_version
        where pl.id = ${planId}`;
      if (!row) throw new RateVersionNotFoundError(planId, null);
      return ratesFromColumns(row);
    },
  };

  const ledger: UsageLedgerStore = {
    async appendIfAbsent(entry) {
      return (await insertLedger(sql, [entry])) === 1;
    },
    appendMany: (entries) => insertLedger(sql, entries),
    async totals(accountId, periodStart) {
      const rows = await sql<{ metric: UsageMetric; total: string }[]>`
        select metric, sum(quantity_micro_units)::text as total
        from public.usage_ledger
        where account_id = ${accountId}::uuid
          and period_start = ${periodStart.toISOString()}::timestamptz
        group by metric`;
      const totals: Record<UsageMetric, bigint> = { storage_byte_seconds: 0n };
      for (const r of rows) totals[r.metric] = BigInt(r.total);
      return totals;
    },
    async list(accountId, periodStart, until) {
      const rows = await sql<LedgerRow[]>`
        select account_id, metric, quantity_micro_units::text as quantity, unit, source_id,
               event_time, period_start, rating_version,
               estimated_cost_micro_usd::text as estimated_cost
        from public.usage_ledger
        where account_id = ${accountId}::uuid
          and period_start = ${periodStart.toISOString()}::timestamptz
          and event_time <= ${until.toISOString()}::timestamptz
        order by event_time, metric, source_id`;
      return rows.map(ledgerEntryFromRow);
    },
  };

  const accounts: BillingAccountStore = {
    async get(accountId) {
      const [r] = await sql<
        {
          account_id: string;
          status: BillingAccountStatus;
          plan_id: PlanId;
          rate_version: number;
          stripe_customer_id: string | null;
          spend_cap_micro_usd: string | null;
          warning_thresholds: string;
          billing_period_start: Date | string | null;
          billing_period_end: Date | string | null;
          past_due_since: Date | string | null;
          restricted_since: Date | string | null;
          canceled_at: Date | string | null;
        }[]
      >`
        select ba.user_id as account_id, ba.status, pl.id as plan_id, pl.rate_version,
               ba.stripe_customer_id, ba.spend_cap_micro_usd::text as spend_cap_micro_usd,
               array_to_string(ba.warning_thresholds, ',') as warning_thresholds,
               ba.billing_period_start, ba.billing_period_end,
               ba.past_due_since, ba.restricted_since, ba.canceled_at
        from public.billing_accounts ba
        left join public.profiles p on p.user_id = ba.user_id
        join public.plans pl on pl.id = coalesce(p.plan_id, 'free')
        where ba.user_id = ${accountId}::uuid`;
      if (!r) return null;
      return {
        accountId: r.account_id,
        status: r.status,
        planId: r.plan_id,
        rateVersion: r.rate_version,
        stripeCustomerId: r.stripe_customer_id,
        spendCapMicroUsd: toIntOrNull(r.spend_cap_micro_usd, 'spend_cap_micro_usd'),
        warningThresholdsPct: r.warning_thresholds
          ? r.warning_thresholds.split(',').map((v) => toInt(v, 'warning_threshold'))
          : [],
        billingPeriodStart: toDateOrNull(r.billing_period_start),
        billingPeriodEnd: toDateOrNull(r.billing_period_end),
        pastDueSince: toDateOrNull(r.past_due_since),
        restrictedSince: toDateOrNull(r.restricted_since),
        canceledAt: toDateOrNull(r.canceled_at),
      };
    },
  };

  const reservations: CostReservationStore = {
    /**
     * Live upload intents (original + estimated derivatives, the same estimate admission uses).
     * Archives are not billed (ADR-008), so they reserve nothing.
     */
    async pending(accountId) {
      const rows = await sql<{ bytes: string }[]>`
        select m.byte_size::text as bytes
        from public.media m
        join public.galleries g on g.id = m.gallery_id
        join public.upload_sessions us on us.id = m.upload_session_id
        where g.owner_id = ${accountId}::uuid
          and m.status in ('reserved', 'uploading')
          and us.status = 'pending' and us.expires_at > now()`;
      return rows.map((r): Reservation => ({
        kind: 'upload',
        bytes: estimateStoredFootprintBytes({
          originalBytes: toInt(r.bytes, 'reservation bytes'),
          items: 1,
        }),
      }));
    },
  };

  return {
    plans,
    ledger,
    accounts,
    reservations,

    async storageAccrualCandidates(windowEnd, limit) {
      const rows = await sql<
        (AccountContextRow & {
          accrued_through: Date | string | null;
          cursor_stored_bytes: string | null;
          stored_bytes_now: string;
        })[]
      >`
        select ba.user_id as account_id, ba.billing_period_start, ba.billing_period_end, ${rateColumns(sql)},
               c.accrued_through, c.stored_bytes::text as cursor_stored_bytes,
               (
                 coalesce((
                   select sum(m.byte_size) from public.media m
                   join public.galleries g on g.id = m.gallery_id
                   where g.owner_id = ba.user_id and g.deleted_at is null
                     and m.deleted_at is null and m.status in ('uploaded', 'processing', 'ready')
                 ), 0)
                 + coalesce((
                   select sum(mv.byte_size) from public.media_variants mv
                   join public.media m on m.id = mv.media_id
                   join public.galleries g on g.id = m.gallery_id
                   where g.owner_id = ba.user_id and g.deleted_at is null and m.deleted_at is null
                 ), 0)
                 -- Temp "Download all" archives (T24) until they expire (24 h, FR-D04).
                 + coalesce((
                   select sum(ap.byte_size) from public.archive_parts ap
                   join public.archive_jobs aj on aj.id = ap.job_id
                   join public.galleries g on g.id = aj.gallery_id
                   where g.owner_id = ba.user_id and g.deleted_at is null
                     and aj.status in ('running', 'ready') and ap.completed_at is not null
                 ), 0)
               )::text as stored_bytes_now
        ${accountContextFrom()}
        left join public.storage_accrual_cursors c on c.account_id = ba.user_id
        where c.accrued_through is null
           or c.accrued_through < ${windowEnd.toISOString()}::timestamptz
        order by c.accrued_through asc nulls first, ba.user_id
        limit ${limit}`;
      return rows.map((r) => ({
        ...contextFromRow(r),
        cursor:
          r.accrued_through === null || r.cursor_stored_bytes === null
            ? null
            : {
                accruedThrough: toDate(r.accrued_through),
                storedBytes: toInt(r.cursor_stored_bytes, 'stored_bytes'),
              },
        storedBytesNow: toInt(r.stored_bytes_now, 'stored_bytes_now'),
      }));
    },

    async storageByteSecondsToDate(accountId, periodStart) {
      const [row] = await sql<{ total: string }[]>`
        select coalesce(sum(quantity_micro_units), 0)::text as total
        from public.usage_ledger
        where account_id = ${accountId}::uuid and metric = 'storage_byte_seconds'
          and period_start = ${periodStart.toISOString()}::timestamptz`;
      return BigInt(row?.total ?? '0');
    },

    async commitStorageAccrual(accountId, expected, entries, next) {
      let moved = false;
      // A savepoint when already inside a caller's transaction (tests, composed writes).
      const atomically = (fn: (tx: postgres.TransactionSql) => Promise<void>) => {
        const maybeTx = sql as unknown as Partial<postgres.TransactionSql>;
        return typeof maybeTx.savepoint === 'function' ? maybeTx.savepoint(fn) : sql.begin(fn);
      };
      await atomically(async (tx) => {
        const rows =
          expected === null
            ? await tx<{ account_id: string }[]>`
                insert into public.storage_accrual_cursors (account_id, accrued_through, stored_bytes)
                values (${accountId}::uuid, ${next.accruedThrough.toISOString()}::timestamptz,
                        ${String(next.storedBytes)}::bigint)
                on conflict (account_id) do nothing
                returning account_id`
            : await tx<{ account_id: string }[]>`
                update public.storage_accrual_cursors
                set accrued_through = ${next.accruedThrough.toISOString()}::timestamptz,
                    stored_bytes = ${String(next.storedBytes)}::bigint
                where account_id = ${accountId}::uuid
                  and accrued_through = ${expected.toISOString()}::timestamptz
                returning account_id`;
        if (rows.length === 0) return;
        await insertLedger(tx, entries);
        moved = true;
      });
      return moved;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// billing state: spend-cap alerts + hourly maintenance sweep (T32/T33)
// ---------------------------------------------------------------------------------------------

/** Account the hourly sweep looks at, with what `fitsFreeCaps` needs. */
export interface SweepCandidate {
  accountId: string;
  status: BillingAccountStatus;
  pastDueSince: Date | null;
  restrictedSince: Date | null;
  canceledAt: Date | null;
  activeGalleries: number;
  /** Originals (uploaded/processing/ready) + derivatives in non-deleted galleries. */
  storedBytes: number;
}

/** `SafeguardStore` (spend-cap alerts, `@lumra/billing`) plus the hourly sweep's reads/writes. */
export interface BillingStateRepository extends SafeguardStore {
  /** past_due / canceled / Pro accounts after `afterId` (keyset by id). */
  sweepCandidates(afterId: string | null, limit: number): Promise<SweepCandidate[]>;
  /** Compare-and-set status transition from the sweep, with access re-sync and notices. */
  applySweep(
    accountId: string,
    expectedStatus: BillingAccountStatus,
    next: { status: BillingAccountStatus; restrictedSince: Date | null; canceledAt: Date | null },
    options: { traceId: string; notices: EmailNotice[] },
  ): Promise<boolean>;
}

interface SafeguardRow extends RateColumns {
  account_id: string;
  spend_cap_micro_usd: string | null;
  warning_thresholds: string;
  billing_period_start: Date | string | null;
  billing_period_end: Date | string | null;
}

/** Runs `fn` in a transaction, or a savepoint when `sql` already is one (tests, composed writes). */
function atomically(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<boolean>,
): Promise<boolean> {
  const maybeTx = sql as unknown as Partial<postgres.TransactionSql>;
  return (
    typeof maybeTx.savepoint === 'function' ? maybeTx.savepoint(fn) : sql.begin(fn)
  ) as Promise<boolean>;
}

function atomicallyList<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T[]>,
): Promise<T[]> {
  const maybeTx = sql as unknown as Partial<postgres.TransactionSql>;
  return (
    typeof maybeTx.savepoint === 'function' ? maybeTx.savepoint(fn) : sql.begin(fn)
  ) as Promise<T[]>;
}

async function enqueueNotice(
  tx: postgres.TransactionSql,
  accountId: string,
  notice: EmailNotice,
  traceId: string,
): Promise<void> {
  await tx`select public.enqueue_account_email(
    ${accountId}::uuid, ${notice.template}, ${notice.dedupeKey},
    ${JSON.stringify(notice.data ?? {})}::text::jsonb, ${traceId})`;
}

export function createBillingStateRepository(sql: postgres.Sql): BillingStateRepository {
  return {
    async safeguardContexts(accountIds, now) {
      if (accountIds.length === 0) return [];
      const rows = await sql<SafeguardRow[]>`
        select ba.user_id as account_id, ba.spend_cap_micro_usd::text as spend_cap_micro_usd,
               array_to_string(ba.warning_thresholds, ',') as warning_thresholds,
               ba.billing_period_start, ba.billing_period_end,
               ${rateColumns(sql)}
        from public.billing_accounts ba
        left join public.profiles p on p.user_id = ba.user_id
        join public.plans pl on pl.id = coalesce(p.plan_id, 'free')
        join public.plan_rate_versions pv
          on pv.plan_id = pl.id and pv.rate_version = pl.rate_version
        where ba.user_id = any(${pgArray([...new Set(accountIds)])}::uuid[])`;
      if (rows.length === 0) return [];
      const periods = rows.map((r) => ({
        r,
        period: billingPeriodAt(
          {
            billingPeriodStart: toDateOrNull(r.billing_period_start),
            billingPeriodEnd: toDateOrNull(r.billing_period_end),
          },
          now,
        ),
      }));
      const payload = JSON.stringify(
        periods.map(({ r, period }) => ({
          account_id: r.account_id,
          period_start: period.start.toISOString(),
        })),
      );
      const totals = await sql<
        {
          account_id: string;
          byte_seconds: string;
          alerts: string | null;
        }[]
      >`
        select k.account_id,
               coalesce(sum(l.quantity_micro_units)
                 filter (where l.metric = 'storage_byte_seconds'), 0)::text as byte_seconds,
               (select string_agg(a.threshold_pct::text, ',' order by a.threshold_pct)
                from public.billing_alerts a
                where a.account_id = k.account_id and a.period_start = k.period_start) as alerts
        from jsonb_to_recordset(${payload}::text::jsonb) as k(account_id uuid, period_start timestamptz)
        left join public.usage_ledger l
          on l.account_id = k.account_id and l.period_start = k.period_start
        group by k.account_id, k.period_start`;
      const byAccount = new Map(totals.map((t) => [t.account_id, t]));
      return periods.map(({ r, period }) => {
        const t = byAccount.get(r.account_id);
        return {
          accountId: r.account_id,
          plan: ratesFromColumns(r),
          spendCapMicroUsd: toIntOrNull(r.spend_cap_micro_usd, 'spend_cap_micro_usd'),
          warningThresholdsPct: r.warning_thresholds
            ? r.warning_thresholds.split(',').map((v) => toInt(v, 'warning_threshold'))
            : [],
          period,
          usage: { storageByteSecondsToDate: BigInt(t?.byte_seconds ?? '0') },
          alertsSent: t?.alerts ? t.alerts.split(',').map((v) => toInt(v, 'threshold_pct')) : [],
        };
      });
    },

    recordSpendAlerts(accountId, periodStart, thresholdsPct, details) {
      return atomicallyList(sql, async (tx) => {
        if (thresholdsPct.length === 0) return [];
        const payload = JSON.stringify(thresholdsPct.map((t) => ({ t })));
        const rows = await tx<{ threshold_pct: number }[]>`
          insert into public.billing_alerts
            (account_id, period_start, threshold_pct, spend_micro_usd, cap_micro_usd)
          select ${accountId}::uuid, ${periodStart.toISOString()}::timestamptz, r.t,
                 ${String(details.spendMicroUsd)}::bigint, ${String(details.capMicroUsd)}::bigint
          from jsonb_to_recordset(${payload}::text::jsonb) as r(t smallint)
          on conflict on constraint billing_alerts_once do nothing
          returning threshold_pct`;
        const recorded = rows.map((r) => Number(r.threshold_pct)).sort((a, b) => a - b);
        for (const threshold of recorded) {
          await enqueueNotice(
            tx,
            accountId,
            {
              template: 'spend_cap_alert',
              dedupeKey: `email:spend_cap_alert:${accountId}:${periodStart.toISOString()}:${threshold}`,
              data: {
                thresholdPct: threshold,
                spendMicroUsd: details.spendMicroUsd,
                capMicroUsd: details.capMicroUsd,
              },
            },
            details.traceId,
          );
        }
        return recorded;
      });
    },

    async sweepCandidates(afterId, limit) {
      const rows = await sql<
        {
          account_id: string;
          status: BillingAccountStatus;
          past_due_since: Date | string | null;
          restricted_since: Date | string | null;
          canceled_at: Date | string | null;
          active_galleries: number;
          stored_bytes: string;
        }[]
      >`
        select ba.user_id as account_id, ba.status, ba.past_due_since, ba.restricted_since,
               ba.canceled_at,
               (select count(*)::int from public.galleries g
                 where g.owner_id = ba.user_id and g.deleted_at is null) as active_galleries,
               (
                 coalesce((
                   select sum(m.byte_size) from public.media m
                   join public.galleries g on g.id = m.gallery_id
                   where g.owner_id = ba.user_id and g.deleted_at is null
                     and m.deleted_at is null and m.status in ('uploaded', 'processing', 'ready')
                 ), 0)
                 + coalesce((
                   select sum(mv.byte_size) from public.media_variants mv
                   join public.media m on m.id = mv.media_id
                   join public.galleries g on g.id = m.gallery_id
                   where g.owner_id = ba.user_id and g.deleted_at is null and m.deleted_at is null
                 ), 0)
               )::text as stored_bytes
        from public.billing_accounts ba
        where (
            ba.status in ('past_due', 'canceled')
            -- Pro storage accrues hourly and can cross spend-cap alert thresholds.
            or exists (select 1 from public.profiles p where p.user_id = ba.user_id and p.plan_id = 'pro')
          )
          and (${afterId}::uuid is null or ba.user_id > ${afterId}::uuid)
        order by ba.user_id
        limit ${limit}`;
      return rows.map((r) => ({
        accountId: r.account_id,
        status: r.status,
        pastDueSince: toDateOrNull(r.past_due_since),
        restrictedSince: toDateOrNull(r.restricted_since),
        canceledAt: toDateOrNull(r.canceled_at),
        activeGalleries: r.active_galleries,
        storedBytes: toInt(r.stored_bytes, 'stored_bytes'),
      }));
    },

    applySweep(accountId, expectedStatus, next, options) {
      return atomically(sql, async (tx) => {
        const rows = await tx<{ user_id: string }[]>`
          update public.billing_accounts
          set status = ${next.status}::public.billing_account_status,
              restricted_since = ${next.restrictedSince?.toISOString() ?? null}::timestamptz,
              canceled_at = ${next.canceledAt?.toISOString() ?? null}::timestamptz,
              past_due_since = case when ${next.status}::text = 'free' then null else past_due_since end
          where user_id = ${accountId}::uuid
            and status = ${expectedStatus}::public.billing_account_status
          returning user_id`;
        if (rows.length === 0) return false;
        await tx`select public.enqueue_owner_access_sync(${accountId}::uuid, ${options.traceId})`;
        for (const notice of options.notices) {
          await enqueueNotice(tx, accountId, notice, options.traceId);
        }
        return true;
      });
    },
  };
}
