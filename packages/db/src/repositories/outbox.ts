/**
 * SERVER-ONLY. Transactional outbox relay persistence (PRD §6.3, T12).
 *
 * Claiming uses a short lease instead of holding a transaction open across the queue publish:
 * `FOR UPDATE SKIP LOCKED` picks rows no other relay is claiming right now, and the same
 * statement pushes `available_at` forward by the lease so concurrent or overlapping relays never
 * pick them again until the lease expires. A relay that crashes after publishing but before
 * `markPublished` lets the lease lapse and the row is re-published — at-least-once delivery,
 * which every consumer tolerates via the message `dedupeKey`.
 */
import type postgres from 'postgres';
import { pgArray } from '../client';

export interface OutboxRow {
  id: string;
  eventName: string;
  aggregateId: string;
  payload: unknown;
  dedupeKey: string | null;
  attemptCount: number;
}

export interface OutboxRepository {
  claim(limit: number, leaseSeconds: number): Promise<OutboxRow[]>;
  markPublished(ids: readonly string[]): Promise<void>;
  /** Records the failure and schedules the next attempt `retryInSeconds` from now. */
  markFailed(id: string, error: string, retryInSeconds: number): Promise<void>;
}

interface Row {
  id: string;
  event_name: string;
  aggregate_id: string;
  payload: unknown;
  dedupe_key: string | null;
  attempt_count: number;
}

export function createOutboxRepository(sql: postgres.Sql): OutboxRepository {
  return {
    async claim(limit, leaseSeconds) {
      const rows = await sql<Row[]>`
        with picked as (
          select id from public.job_outbox
          where processed_at is null and available_at <= now()
          order by available_at, created_at
          limit ${limit}
          for update skip locked
        )
        update public.job_outbox o
        set available_at = now() + make_interval(secs => ${leaseSeconds})
        from picked
        where o.id = picked.id
        returning o.id, o.event_name, o.aggregate_id, o.payload, o.dedupe_key, o.attempt_count`;
      return rows.map((r) => ({
        id: r.id,
        eventName: r.event_name,
        aggregateId: r.aggregate_id,
        payload: r.payload,
        dedupeKey: r.dedupe_key,
        attemptCount: r.attempt_count,
      }));
    },

    async markPublished(ids) {
      if (ids.length === 0) return;
      await sql`
        update public.job_outbox
        set processed_at = now(), last_error = null
        where id = any(${pgArray(ids)}::uuid[]) and processed_at is null`;
    },

    async markFailed(id, error, retryInSeconds) {
      await sql`
        update public.job_outbox
        set attempt_count = attempt_count + 1,
            last_error = ${error.slice(0, 500)},
            available_at = now() + make_interval(secs => ${retryInSeconds})
        where id = ${id} and processed_at is null`;
    },
  };
}
