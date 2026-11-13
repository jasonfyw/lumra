import { publicDeliveryState } from '@lumra/billing';
import type { GalleryAccessState } from '@lumra/contracts';
import type { AccessStateRepository, GalleryAccessRow } from '@lumra/db';
import { galleryAccessSnapshot } from '@lumra/domain';
import { writeGalleryAccessState, type KvWriter } from '@lumra/tokens';
import type { Logger } from '../log';

/**
 * KV access-state writer (ADR-001, T20). Postgres is authoritative; on `gallery.access_changed`
 * (publish, password/expiry change, suspension) and `gallery.delete` the worker re-reads the
 * gallery and rewrites `gallery:{id}` in the `ACCESS_STATE` namespace the media gateway reads.
 *
 * Idempotent and order-independent: every run writes the *current* DB state, so duplicate or
 * reordered deliveries converge on the same document. Drafts write nothing (a missing document
 * already fails closed at the gateway); deleted or vanished galleries write a tombstone.
 */
export interface AccessStateDeps {
  repo: AccessStateRepository;
  kv: KvWriter;
  log: Logger;
  now?: () => Date;
}

export type AccessStateOutcome = 'written' | 'tombstoned' | 'skipped_draft';

/**
 * Public delivery is suspended when billing policy says so (PRD §9.4): past-due grace elapsed,
 * restricted/canceled, or the delivery safety cutoff (Free delivery cap / spending cap, T28/T32).
 * A billing row that violates its own invariants fails closed (`publicDeliveryState`).
 */
export function isDeliverySuspended(row: GalleryAccessRow, now: Date): boolean {
  return !publicDeliveryState(row.billing, now).available;
}

export function accessStateFor(row: GalleryAccessRow | null, now: Date): GalleryAccessState | null {
  return galleryAccessSnapshot(
    row && {
      status: row.status,
      deletedAt: row.deletedAt,
      accessVersion: row.accessVersion,
      expiresAt: row.expiresAt,
      deliverySuspended: isDeliverySuspended(row, now),
    },
    now,
  );
}

export async function syncGalleryAccessState(
  galleryId: string,
  deps: AccessStateDeps,
): Promise<AccessStateOutcome> {
  const now = deps.now?.() ?? new Date();
  const row = await deps.repo.getGalleryAccess(galleryId);
  const state = accessStateFor(row, now);
  if (!state) return 'skipped_draft';
  // Throws on failure → the queue retries with backoff (then DLQ); the gateway keeps serving the
  // previous state only for tokens still inside their ≤ 5 min lifetime.
  await writeGalleryAccessState({ binding: deps.kv }, galleryId, state);
  return state.deleted ? 'tombstoned' : 'written';
}

export interface ReconcileResult {
  scanned: number;
  written: number;
  tombstoned: number;
  failed: number;
}

/**
 * Rewrites KV for every published or deleted gallery (keyset pages of `batchSize`). Covers lost
 * outbox messages and time-based billing transitions (past-due grace elapsing) that no write
 * triggers. Scheduled by T13; safe to run any time. Per-gallery failures are counted and logged
 * (ids only) without aborting the sweep.
 */
export async function reconcileAccessStates(
  deps: AccessStateDeps,
  options: { batchSize?: number; maxGalleries?: number } = {},
): Promise<ReconcileResult> {
  const batchSize = options.batchSize ?? 500;
  const maxGalleries = options.maxGalleries ?? Number.POSITIVE_INFINITY;
  const result: ReconcileResult = { scanned: 0, written: 0, tombstoned: 0, failed: 0 };
  let after: string | null = null;
  while (result.scanned < maxGalleries) {
    const ids = await deps.repo.listSyncableGalleryIds(after, batchSize);
    if (ids.length === 0) break;
    for (const id of ids) {
      if (result.scanned >= maxGalleries) break;
      result.scanned++;
      try {
        const outcome = await syncGalleryAccessState(id, deps);
        if (outcome === 'written') result.written++;
        else if (outcome === 'tombstoned') result.tombstoned++;
      } catch (error) {
        result.failed++;
        deps.log.warn('access-state reconcile failed', { galleryId: id, err: error });
      }
    }
    after = ids[ids.length - 1] ?? null;
    if (ids.length < batchSize) break;
  }
  return result;
}
