import { ACCESS_STATE } from '@lumra/config';
import { galleryAccessStateSchema, type GalleryAccessState } from '@lumra/contracts';

/**
 * Gallery access state for the media gateway (ADR-001).
 *
 * Source of truth is Postgres (`galleries`). The web app mirrors the fields the gateway needs
 * into Cloudflare KV (`ACCESS_STATE` namespace, key `gallery:{id}`) with
 * `writeGalleryAccessState` on publish, password change/revocation, expiry change, delivery
 * suspension and deletion. The gateway reads it per request through a ≤5 s in-isolate memo
 * and fails closed when the read errors or the document is missing/invalid.
 */
export interface GalleryAccessStore {
  /** Returns null when no state exists. Throws when state cannot be determined. */
  get(galleryId: string): Promise<GalleryAccessState | null>;
}

/** Thrown when the access state is unavailable or corrupt; callers must deny the request. */
export class AccessStateUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AccessStateUnavailableError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function galleryAccessKey(galleryId: string): string {
  if (!UUID.test(galleryId)) throw new Error('Invalid galleryId for access-state key');
  return `${ACCESS_STATE.kvKeyPrefix}${galleryId.toLowerCase()}`;
}

/** Minimal read surface of a Workers `KVNamespace` (kept structural so tests can fake it). */
export interface KvReader {
  get(key: string, type: 'text'): Promise<string | null>;
}

export interface KvWriter {
  put(key: string, value: string): Promise<void>;
}

export interface KvAccessStoreOptions {
  /** Memo TTL; clamped to `ACCESS_STATE.maxMemoTtlMs` (5 s). 0 disables the memo. */
  memoTtlMs?: number;
  maxEntries?: number;
  clock?: () => number;
}

export function parseGalleryAccessState(raw: string): GalleryAccessState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new AccessStateUnavailableError('Access state is not valid JSON', { cause });
  }
  const parsed = galleryAccessStateSchema.safeParse(json);
  if (!parsed.success) throw new AccessStateUnavailableError('Access state failed validation');
  return parsed.data;
}

/**
 * KV-backed store with a per-isolate memo. Results (including "missing") are memoized for at
 * most 5 s; errors are never memoized so recovery is immediate.
 */
export function createKvGalleryAccessStore(
  kv: KvReader,
  options: KvAccessStoreOptions = {},
): GalleryAccessStore {
  const ttl = Math.max(
    0,
    Math.min(options.memoTtlMs ?? ACCESS_STATE.maxMemoTtlMs, ACCESS_STATE.maxMemoTtlMs),
  );
  const maxEntries = options.maxEntries ?? 1_000;
  const clock = options.clock ?? (() => Date.now());
  const memo = new Map<string, { value: GalleryAccessState | null; at: number }>();

  return {
    async get(galleryId) {
      const key = galleryAccessKey(galleryId);
      const now = clock();
      const hit = memo.get(key);
      if (hit && now - hit.at < ttl) return hit.value;

      let raw: string | null;
      try {
        raw = await kv.get(key, 'text');
      } catch (cause) {
        memo.delete(key);
        throw new AccessStateUnavailableError('Access state read failed', { cause });
      }
      const value = raw === null ? null : parseGalleryAccessState(raw);
      if (ttl > 0) {
        memo.delete(key);
        if (memo.size >= maxEntries) {
          const oldest = memo.keys().next().value;
          if (oldest !== undefined) memo.delete(oldest);
        }
        memo.set(key, { value, at: now });
      }
      return value;
    },
  };
}

export type GalleryAccessDecision = 'allow' | 'not_found' | 'revoked' | 'expired' | 'suspended';

/** Pure authorization rule applied by the gateway after token verification. */
export function evaluateGalleryAccess(
  state: GalleryAccessState | null,
  tokenAccessVersion: number,
  now: Date,
): GalleryAccessDecision {
  if (!state || state.deleted) return 'not_found';
  // Any mismatch denies: lower = revoked (password change), higher = KV not yet updated.
  if (state.accessVersion !== tokenAccessVersion) return 'revoked';
  if (state.expiresAt !== null && Date.parse(state.expiresAt) <= now.getTime()) return 'expired';
  if (state.deliverySuspended) return 'suspended';
  return 'allow';
}

/** Cloudflare KV REST API target, for writers outside Workers (the Next.js server on Vercel). */
export interface KvRestTarget {
  accountId: string;
  namespaceId: string;
  /** API token scoped to "Workers KV Storage: Edit" on this namespace only. */
  apiToken: string;
  fetch?: typeof fetch;
}

export type AccessStateWriteTarget = { binding: KvWriter } | { rest: KvRestTarget };

const CF_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * Writes the gateway's copy of a gallery's access state. Call after the corresponding DB
 * transaction commits (publish, password change, expiry change, suspension, deletion). On
 * failure the caller must retry (e.g. via the outbox) — until it succeeds the gateway keeps
 * serving the previous state for tokens still within their ≤5 min lifetime.
 */
export async function writeGalleryAccessState(
  target: AccessStateWriteTarget,
  galleryId: string,
  state: GalleryAccessState,
): Promise<void> {
  const key = galleryAccessKey(galleryId);
  const body = JSON.stringify(galleryAccessStateSchema.parse(state));

  if ('binding' in target) {
    await target.binding.put(key, body);
    return;
  }

  const { accountId, namespaceId, apiToken } = target.rest;
  if (!CF_ID.test(accountId) || !CF_ID.test(namespaceId)) {
    throw new Error('Invalid Cloudflare account or namespace id');
  }
  const doFetch = target.rest.fetch ?? fetch;
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const res = await doFetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body,
  });
  let success = res.ok;
  if (success) {
    const json = (await res.json().catch(() => null)) as { success?: unknown } | null;
    success = json?.success === true;
  }
  // Never include the token or response body in the error.
  if (!success) throw new Error(`KV access-state write failed (HTTP ${res.status})`);
}
