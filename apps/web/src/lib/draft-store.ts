/**
 * Browser-side persistence for guest drafts and resumable uploads (FR-A01, FR-M03).
 *
 * Stores only the draft id/expiry and non-sensitive progress references: which file (name, size,
 * type, lastModified — enough to match a reselected `File`), its upload intent and the part
 * ETags already accepted by R2. Never file bytes, never the guest capability (HttpOnly cookie
 * only), never presigned URLs. Every record is rebuilt field by field before it is written, so a
 * caller can't accidentally persist a `File`/`Blob` or a URL.
 */
const DB_NAME = 'lumra-drafts';
const DB_VERSION = 1;
const DRAFT_STORE = 'draft';
const UPLOAD_STORE = 'uploads';
const DRAFT_KEY = 'current';

export interface StoredDraft {
  galleryId: string;
  draftExpiresAt: string;
}

export interface StoredUploadRef {
  /** Stable per-file UUID sent as `clientId` (idempotency key). */
  clientId: string;
  galleryId: string;
  intentId: string | null;
  mediaId: string | null;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  /** Parts R2 accepted (from PUT responses); reconciled with `GET /api/v1/uploads/{id}`. */
  completedParts: { number: number; etag: string }[];
  status: 'queued' | 'uploading' | 'uploaded' | 'failed' | 'cancelled';
  updatedAt: number;
}

const UPLOAD_STATUSES: readonly StoredUploadRef['status'][] = [
  'queued',
  'uploading',
  'uploaded',
  'failed',
  'cancelled',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ETAG = /^"?[A-Za-z0-9-]{1,128}"?$/;

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function requireUuid(value: unknown, field: string): string {
  const id = uuidOrNull(value);
  if (!id) throw new TypeError(`${field} must be a UUID`);
  return id;
}

function safeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

export function sanitizeDraft(input: StoredDraft): StoredDraft {
  const expires = new Date(input.draftExpiresAt);
  if (Number.isNaN(expires.getTime())) throw new TypeError('draftExpiresAt must be a date');
  return {
    galleryId: requireUuid(input.galleryId, 'galleryId'),
    draftExpiresAt: expires.toISOString(),
  };
}

/** Whitelists and validates a progress reference; anything else (bytes, URLs) is dropped. */
export function sanitizeUploadRef(input: StoredUploadRef): StoredUploadRef {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new TypeError('name is required');
  }
  if (!UPLOAD_STATUSES.includes(input.status)) throw new TypeError('invalid status');
  const parts = Array.isArray(input.completedParts) ? input.completedParts : [];
  return {
    clientId: requireUuid(input.clientId, 'clientId'),
    galleryId: requireUuid(input.galleryId, 'galleryId'),
    intentId: uuidOrNull(input.intentId),
    mediaId: uuidOrNull(input.mediaId),
    name: input.name.slice(0, 255),
    size: safeInt(input.size, 'size'),
    type: typeof input.type === 'string' ? input.type.slice(0, 100) : '',
    lastModified: safeInt(input.lastModified, 'lastModified'),
    completedParts: parts
      .filter(
        (p) =>
          p &&
          Number.isInteger(p.number) &&
          p.number >= 1 &&
          p.number <= 10_000 &&
          typeof p.etag === 'string' &&
          ETAG.test(p.etag),
      )
      .map((p) => ({ number: p.number, etag: p.etag }))
      .slice(0, 10_000),
    status: input.status,
    updatedAt: safeInt(input.updatedAt, 'updatedAt'),
  };
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface DraftStore {
  getDraft(now?: Date): Promise<StoredDraft | null>;
  saveDraft(draft: StoredDraft): Promise<void>;
  /** Removes the draft and every upload reference (e.g. after claim or expiry). */
  clear(): Promise<void>;
  putUpload(ref: StoredUploadRef): Promise<void>;
  getUpload(clientId: string): Promise<StoredUploadRef | null>;
  listUploads(galleryId: string): Promise<StoredUploadRef[]>;
  deleteUpload(clientId: string): Promise<void>;
  close(): void;
}

/**
 * Opens the store. `factory` defaults to `globalThis.indexedDB`; returns null when IndexedDB is
 * unavailable (private mode, SSR), in which case the app simply can't offer resume.
 */
export async function openDraftStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<DraftStore | null> {
  if (!factory) return null;
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
    if (!db.objectStoreNames.contains(UPLOAD_STORE)) {
      const uploads = db.createObjectStore(UPLOAD_STORE, { keyPath: 'clientId' });
      uploads.createIndex('galleryId', 'galleryId');
    }
  };
  let db: IDBDatabase;
  try {
    db = await promisify(open);
  } catch {
    return null;
  }

  return {
    async getDraft(now = new Date()) {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const draft = (await promisify(tx.objectStore(DRAFT_STORE).get(DRAFT_KEY))) as
        StoredDraft | undefined;
      if (!draft) return null;
      if (new Date(draft.draftExpiresAt).getTime() <= now.getTime()) return null;
      return draft;
    },
    async saveDraft(draft) {
      const clean = sanitizeDraft(draft);
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      tx.objectStore(DRAFT_STORE).put(clean, DRAFT_KEY);
      await done(tx);
    },
    async clear() {
      const tx = db.transaction([DRAFT_STORE, UPLOAD_STORE], 'readwrite');
      tx.objectStore(DRAFT_STORE).clear();
      tx.objectStore(UPLOAD_STORE).clear();
      await done(tx);
    },
    async putUpload(ref) {
      const clean = sanitizeUploadRef(ref);
      const tx = db.transaction(UPLOAD_STORE, 'readwrite');
      tx.objectStore(UPLOAD_STORE).put(clean);
      await done(tx);
    },
    async getUpload(clientId) {
      const tx = db.transaction(UPLOAD_STORE, 'readonly');
      const ref = (await promisify(tx.objectStore(UPLOAD_STORE).get(clientId))) as
        StoredUploadRef | undefined;
      return ref ?? null;
    },
    async listUploads(galleryId) {
      const tx = db.transaction(UPLOAD_STORE, 'readonly');
      const refs = (await promisify(
        tx.objectStore(UPLOAD_STORE).index('galleryId').getAll(galleryId),
      )) as StoredUploadRef[];
      return refs.sort((a, b) => a.updatedAt - b.updatedAt);
    },
    async deleteUpload(clientId) {
      const tx = db.transaction(UPLOAD_STORE, 'readwrite');
      tx.objectStore(UPLOAD_STORE).delete(clientId);
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}

/** True when `file` is plausibly the same file as `ref` (for the resume reselect prompt). */
export function matchesUploadRef(
  file: { name: string; size: number; lastModified: number },
  ref: Pick<StoredUploadRef, 'name' | 'size' | 'lastModified'>,
): boolean {
  return file.name === ref.name && file.size === ref.size && file.lastModified === ref.lastModified;
}
