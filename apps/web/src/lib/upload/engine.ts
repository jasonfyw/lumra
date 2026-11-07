import { GUEST_LIMITS, IMAGE_VALIDATION, type AcceptedPhotoMime } from '@lumra/config';
import type { GuestDraftMedia, MediaStatus } from '@lumra/contracts';
import { partLength, planFromReservation, precheckFile, type UploadPlan } from '@lumra/media';
import { matchesUploadRef, type DraftStore, type StoredUploadRef } from '../draft-store';
import { isAbortError, UploadApiError, type UploadApi } from './api-client';
import { backoffDelay, sleep, type BackoffOptions } from './backoff';
import { sha256Hasher, type Hasher } from './checksum';
import {
  AdaptiveConcurrency,
  baseConcurrency,
  detectMobile,
  type ConnectionInfo,
} from './concurrency';
import { rejectionMessage, type RejectionCode } from './messages';
import { xhrTransport, type PutTransport } from './transport';

/**
 * Per-file upload state (PRD §4 "Upload UI state"):
 * queued → uploading → uploaded → processing → ready, plus recoverable `failed`, `cancelled`
 * and `removed`. `awaiting_file` is the resume state after a reload: the engine knows the upload
 * (intent id, completed parts) but needs the user to reselect the `File` (FR-M03).
 */
export type UploadState =
  | 'awaiting_file'
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'removed';

export interface UploadItemError {
  code: string;
  message: string;
  /** The user can retry this item (after signing in when `requiresAuth`). */
  retryable: boolean;
  requiresAuth?: boolean;
}

export interface UploadItemSnapshot {
  clientId: string;
  name: string;
  size: number;
  type: string;
  state: UploadState;
  bytesUploaded: number;
  /** 0–100, integer. */
  percent: number;
  error: UploadItemError | null;
  mediaId: string | null;
  hasFile: boolean;
}

export interface AuthPrompt {
  reason: 'guest_file_limit' | 'guest_byte_limit' | 'draft_expired' | 'unauthenticated';
  message: string;
}

export interface UploadSnapshot {
  /** Every item except `removed`, in the order added. */
  items: readonly UploadItemSnapshot[];
  totals: {
    /** Bytes of items that are or will be uploaded (excludes cancelled/failed-before-start). */
    totalBytes: number;
    uploadedBytes: number;
    percent: number;
    queued: number;
    uploading: number;
    done: number;
    failed: number;
    awaitingFile: number;
  };
  /** Set when an upload needs the user to sign in (guest quota, expired draft). J1/§14.2-2. */
  authPrompt: AuthPrompt | null;
  concurrency: number;
  galleryReady: boolean;
}

export interface Rejection {
  name: string;
  code: RejectionCode;
  message: string;
}

export interface AddResult {
  added: number;
  rejected: Rejection[];
}

export interface GuestQuota {
  maxFiles: number;
  maxBytes: number;
  reservedFiles: number;
  reservedBytes: number;
}

export interface UploadEngineOptions {
  api: UploadApi;
  mode: 'guest' | 'owner';
  galleryId?: string | null;
  store?: DraftStore | null;
  transport?: PutTransport;
  /** `null` disables the client checksum. */
  hasher?: Hasher | null;
  /** Maximum concurrent files; defaults to 3 desktop / 2 mobile, lowered on slow connections. */
  maxConcurrency?: number;
  connection?: ConnectionInfo;
  random?: () => number;
  now?: () => number;
  createClientId?: () => string;
  readPrefix?: (file: Blob) => Promise<Uint8Array>;
  backoff?: BackoffOptions;
  /** Attempts per API call on transient errors (network, 5xx, 429). */
  maxRequestAttempts?: number;
  /** Attempts per part PUT before the file is marked failed (recoverable). */
  maxPartAttempts?: number;
  signBatchSize?: number;
  partTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Owner mode polls `GET /uploads/{id}` per item; at most this many per tick. */
  ownerPollBatch?: number;
  /** A part slower than this (bytes/s) counts as a congestion signal. */
  slowBytesPerSecond?: number;
  progressThrottleMs?: number;
}

interface Item {
  clientId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  mime: AcceptedPhotoMime | null;
  file: File | null;
  state: UploadState;
  bytesUploaded: number;
  intentId: string | null;
  mediaId: string | null;
  plan: UploadPlan | null;
  completedParts: Map<number, string>;
  error: UploadItemError | null;
  controller: AbortController | null;
  /** Reconcile with `GET /uploads/{id}` before uploading (resume / retry with an intent). */
  needsReconcile: boolean;
  /** Counted in the local guest quota estimate (until the server count catches up). */
  quotaCounted: boolean;
  lastPolledAt: number;
}

const ACTIVE: ReadonlySet<UploadState> = new Set(['queued', 'uploading']);
const POLLED: ReadonlySet<UploadState> = new Set(['uploaded', 'processing']);
const DONE: ReadonlySet<UploadState> = new Set(['uploaded', 'processing', 'ready']);

class UploadFailure extends Error {
  constructor(readonly itemError: UploadItemError) {
    super(itemError.message);
  }
}

const INTERRUPTED: UploadItemError = {
  code: 'upload_interrupted',
  message: 'Upload interrupted. Check your connection and retry.',
  retryable: true,
};

function defaultClientId(): string {
  return crypto.randomUUID();
}

async function defaultReadPrefix(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, IMAGE_VALIDATION.sniffBytes).arrayBuffer());
}

/**
 * Framework-agnostic upload queue (T14). Files go browser → R2 with presigned URLs; this class
 * only talks JSON to the Lumra API. React binds to it with `subscribe` + `getSnapshot`
 * (`useSyncExternalStore`).
 */
export class UploadEngine {
  private readonly api: UploadApi;
  private readonly mode: 'guest' | 'owner';
  private galleryId: string | null;
  private store: DraftStore | null;
  private readonly transport: PutTransport;
  private readonly hasher: Hasher | null;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly createClientId: () => string;
  private readonly readPrefix: (file: Blob) => Promise<Uint8Array>;
  private readonly backoff: BackoffOptions;
  private readonly maxRequestAttempts: number;
  private readonly maxPartAttempts: number;
  private readonly signBatchSize: number;
  private readonly partTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly ownerPollBatch: number;
  private readonly slowBytesPerSecond: number;
  private readonly progressThrottleMs: number;

  readonly concurrency: AdaptiveConcurrency;
  private readonly items = new Map<string, Item>();
  private readonly active = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: UploadSnapshot | null = null;
  private authPrompt: AuthPrompt | null = null;
  private quota: GuestQuota | null = null;
  private intentsInFlight = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay: number;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: UploadEngineOptions) {
    this.api = options.api;
    this.mode = options.mode;
    this.galleryId = options.galleryId ?? null;
    this.store = options.store ?? null;
    this.transport = options.transport ?? xhrTransport;
    this.hasher = options.hasher === undefined ? sha256Hasher : options.hasher;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.createClientId = options.createClientId ?? defaultClientId;
    this.readPrefix = options.readPrefix ?? defaultReadPrefix;
    this.backoff = options.backoff ?? {};
    this.maxRequestAttempts = options.maxRequestAttempts ?? 5;
    this.maxPartAttempts = options.maxPartAttempts ?? 6;
    this.signBatchSize = options.signBatchSize ?? 10;
    this.partTimeoutMs = options.partTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 15_000;
    this.ownerPollBatch = options.ownerPollBatch ?? 5;
    this.slowBytesPerSecond = options.slowBytesPerSecond ?? 32 * 1024;
    this.progressThrottleMs = options.progressThrottleMs ?? 100;
    this.pollDelay = this.pollIntervalMs;
    const max = options.maxConcurrency ?? baseConcurrency(detectMobile(), options.connection);
    this.concurrency = new AdaptiveConcurrency(max);
    if (this.mode === 'guest') {
      this.quota = {
        maxFiles: GUEST_LIMITS.maxFiles,
        maxBytes: GUEST_LIMITS.maxBytes,
        reservedFiles: 0,
        reservedBytes: 0,
      };
    }
  }

  // ------------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadSnapshot => {
    this.snapshot ??= this.buildSnapshot();
    return this.snapshot;
  };

  private emit(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  /** Byte progress is frequent: coalesce into at most one emit per `progressThrottleMs`. */
  private emitProgress(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit();
    }, this.progressThrottleMs);
  }

  private buildSnapshot(): UploadSnapshot {
    const items: UploadItemSnapshot[] = [];
    let totalBytes = 0;
    let uploadedBytes = 0;
    let queued = 0;
    let uploading = 0;
    let done = 0;
    let failed = 0;
    let awaitingFile = 0;
    for (const item of this.items.values()) {
      if (item.state === 'removed') continue;
      const finished = DONE.has(item.state);
      const bytes = finished ? item.size : Math.min(item.bytesUploaded, item.size);
      items.push({
        clientId: item.clientId,
        name: item.name,
        size: item.size,
        type: item.type,
        state: item.state,
        bytesUploaded: bytes,
        percent: item.size > 0 ? Math.floor((bytes / item.size) * 100) : 0,
        error: item.error,
        mediaId: item.mediaId,
        hasFile: item.file !== null,
      });
      if (item.state !== 'cancelled') {
        totalBytes += item.size;
        uploadedBytes += bytes;
      }
      if (item.state === 'queued') queued++;
      else if (item.state === 'uploading') uploading++;
      else if (finished) done++;
      else if (item.state === 'failed') failed++;
      else if (item.state === 'awaiting_file') awaitingFile++;
    }
    return {
      items,
      totals: {
        totalBytes,
        uploadedBytes,
        percent: totalBytes > 0 ? Math.floor((uploadedBytes / totalBytes) * 100) : 0,
        queued,
        uploading,
        done,
        failed,
        awaitingFile,
      },
      authPrompt: this.authPrompt,
      concurrency: this.concurrency.limit,
      galleryReady: this.galleryId !== null,
    };
  }

  // ------------------------------------------------------------------ public API

  /** Late-binds the gallery (the zone is usable before the draft/gallery request returns). */
  setGallery(galleryId: string): void {
    this.galleryId = galleryId;
    this.emit();
    this.pump();
  }

  /** Late-binds the progress store (IndexedDB opens asynchronously). */
  setStore(store: DraftStore | null): void {
    this.store = store;
    if (store) for (const item of this.items.values()) this.persist(item);
  }

  /** Latest server quota usage for the guest draft (from `GET /guest/drafts/current`). */
  setGuestQuota(quota: GuestQuota): void {
    if (this.mode !== 'guest' || this.intentsInFlight > 0) return;
    this.quota = { ...quota };
    for (const item of this.items.values()) item.quotaCounted = false;
  }

  setMaxConcurrency(max: number): void {
    this.concurrency.setMax(max);
    this.emit();
    this.pump();
  }

  clearAuthPrompt(): void {
    this.authPrompt = null;
    this.emit();
  }

  getFile(clientId: string): File | null {
    return this.items.get(clientId)?.file ?? null;
  }

  /**
   * Pre-checks and queues files (FR-M08: unsupported files are rejected before any request).
   * Guest drafts also get a local quota estimate so the 21st file / the file crossing 250 MB
   * prompts sign-in without a reservation attempt (§14.2-2).
   */
  async addFiles(files: Iterable<File>): Promise<AddResult> {
    const rejected: Rejection[] = [];
    let added = 0;
    for (const file of files) {
      const reject = (code: RejectionCode) =>
        rejected.push({ name: file.name, code, message: rejectionMessage(file.name, code) });
      const duplicate = [...this.items.values()].some(
        (i) =>
          i.state !== 'removed' &&
          i.state !== 'cancelled' &&
          i.file !== null &&
          matchesUploadRef(file, i),
      );
      if (duplicate) {
        reject('duplicate');
        continue;
      }
      let prefix: Uint8Array;
      try {
        prefix = await this.readPrefix(file);
      } catch {
        reject('unreadable');
        continue;
      }
      const check = precheckFile({ name: file.name, size: file.size, type: file.type }, prefix);
      if (!check.ok) {
        reject(check.code);
        continue;
      }
      const item: Item = {
        clientId: this.createClientId(),
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        mime: check.mime,
        file,
        state: 'queued',
        bytesUploaded: 0,
        intentId: null,
        mediaId: null,
        plan: null,
        completedParts: new Map(),
        error: null,
        controller: null,
        needsReconcile: false,
        quotaCounted: false,
        lastPolledAt: 0,
      };
      this.items.set(item.clientId, item);
      added++;
      const blocked = this.guestQuotaBlock(item);
      if (blocked) this.failQuota(item, blocked);
      else this.persist(item);
    }
    this.emit();
    this.pump();
    return { added, rejected };
  }

  /** Retries a failed item (keeps its `clientId`, so the intent replays idempotently). */
  retry(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || item.state !== 'failed' || item.error?.retryable === false) return;
    item.error = null;
    item.needsReconcile = item.intentId !== null;
    item.state = item.file ? 'queued' : 'awaiting_file';
    if (item.state === 'queued') {
      const blocked = item.intentId ? null : this.guestQuotaBlock(item);
      if (blocked) {
        this.failQuota(item, blocked);
        this.emit();
        return;
      }
    }
    this.persist(item);
    this.emit();
    this.pump();
  }

  /** Retries every recoverable failure (e.g. after signing in). */
  retryAll(): void {
    this.authPrompt = null;
    for (const item of [...this.items.values()]) {
      if (item.state === 'failed' && item.error?.retryable !== false) this.retry(item.clientId);
    }
    this.emit();
  }

  /** Stops an upload and releases its reservation (`POST /uploads/{id}/abort`). */
  cancel(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item) return;
    if (!ACTIVE.has(item.state) && item.state !== 'failed' && item.state !== 'awaiting_file') {
      return;
    }
    item.state = 'cancelled';
    item.error = null;
    item.controller?.abort();
    this.releaseServerReservation(item);
    void this.store?.deleteUpload(item.clientId).catch(() => {});
    this.emit();
    this.pump();
  }

  /**
   * Drops an item from the list. Unfinished uploads are cancelled first. Finished photos are
   * removed with `DELETE /media/{id}` in the editor (TODO(T15)), not here.
   */
  remove(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || DONE.has(item.state)) return;
    if (item.state !== 'cancelled') this.cancel(clientId);
    item.state = 'removed';
    item.file = null;
    this.emit();
  }

  /**
   * Loads unfinished uploads persisted for this gallery (after a reload). They come back as
   * `awaiting_file` until `resumeWith` gets the same files again; finished ones as `uploaded`
   * so polling reports processing → ready.
   */
  async restore(): Promise<number> {
    if (!this.store || !this.galleryId) return 0;
    let refs: StoredUploadRef[];
    try {
      refs = await this.store.listUploads(this.galleryId);
    } catch {
      return 0;
    }
    let restored = 0;
    for (const ref of refs) {
      if (this.items.has(ref.clientId)) continue;
      if (ref.status === 'cancelled') {
        void this.store.deleteUpload(ref.clientId).catch(() => {});
        continue;
      }
      const uploaded = ref.status === 'uploaded';
      this.items.set(ref.clientId, {
        clientId: ref.clientId,
        name: ref.name,
        size: ref.size,
        type: ref.type,
        lastModified: ref.lastModified,
        mime: null,
        file: null,
        state: uploaded ? 'uploaded' : 'awaiting_file',
        bytesUploaded: uploaded ? ref.size : 0,
        intentId: ref.intentId,
        mediaId: ref.mediaId,
        plan: null,
        completedParts: new Map(ref.completedParts.map((p) => [p.number, p.etag])),
        error: null,
        controller: null,
        needsReconcile: ref.intentId !== null,
        quotaCounted: false,
        lastPolledAt: 0,
      });
      restored++;
    }
    this.emit();
    this.ensurePolling();
    return restored;
  }

  /**
   * Matches reselected files to `awaiting_file` items by name + size + lastModified. Matched
   * items resume (parts R2 already has are skipped); any other file is added as a new upload.
   */
  async resumeWith(files: Iterable<File>): Promise<{ resumed: number } & AddResult> {
    const extra: File[] = [];
    let resumed = 0;
    for (const file of files) {
      const item = [...this.items.values()].find(
        (i) => i.state === 'awaiting_file' && matchesUploadRef(file, i),
      );
      if (!item) {
        extra.push(file);
        continue;
      }
      let check;
      try {
        check = precheckFile(file, await this.readPrefix(file));
      } catch {
        check = null;
      }
      if (!check?.ok) {
        extra.push(file);
        continue;
      }
      item.file = file;
      item.mime = check.mime;
      item.type = file.type;
      item.state = 'queued';
      item.needsReconcile = item.intentId !== null;
      resumed++;
    }
    const result = extra.length ? await this.addFiles(extra) : { added: 0, rejected: [] };
    this.emit();
    this.pump();
    return { resumed, ...result };
  }

  /** Gives up on every upload still waiting for its file (releases the reservations). */
  discardAwaiting(): void {
    for (const item of [...this.items.values()]) {
      if (item.state === 'awaiting_file') this.remove(item.clientId);
    }
  }

  /**
   * Shows server-side items this browser has no local record of (guest: from
   * `GET /guest/drafts/current`), e.g. uploads finished before a reload.
   */
  hydrateFromServer(media: readonly GuestDraftMedia[]): void {
    const known = new Set([...this.items.values()].map((i) => i.mediaId).filter(Boolean));
    for (const m of media) {
      if (known.has(m.id) || m.status === 'deleting' || m.status === 'deleted') continue;
      const pending = m.status === 'reserved' || m.status === 'uploading';
      const state: UploadState = pending ? 'failed' : stateFromMedia(m.status);
      this.items.set(m.id, {
        clientId: m.id,
        name: m.filename,
        size: m.size,
        type: m.mime,
        lastModified: 0,
        mime: m.mime,
        file: null,
        state,
        bytesUploaded: DONE.has(state) ? m.size : 0,
        intentId: m.uploadId,
        mediaId: m.id,
        plan: null,
        completedParts: new Map(),
        error: pending
          ? {
              code: 'upload_interrupted',
              message:
                'This upload was interrupted in another tab or browser. Remove it and add the photo again.',
              retryable: false,
            }
          : state === 'failed'
            ? processingFailed()
            : null,
        controller: null,
        needsReconcile: false,
        quotaCounted: false,
        lastPolledAt: 0,
      });
    }
    this.emit();
    this.ensurePolling();
  }

  /** Stops timers and in-flight requests. Server intents stay pending so a reload can resume. */
  dispose(): void {
    this.disposed = true;
    for (const item of this.items.values()) item.controller?.abort();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.pollTimer = null;
    this.progressTimer = null;
  }

  /**
   * Re-activates a disposed engine (React Strict Mode mounts, unmounts and re-mounts effects).
   * Uploads that were aborted by `dispose` are re-queued and reconciled with the server.
   */
  activate(): void {
    if (!this.disposed) return;
    this.disposed = false;
    for (const item of this.items.values()) {
      if (item.state === 'uploading' && !this.active.has(item.clientId)) {
        item.state = 'queued';
        item.needsReconcile = item.intentId !== null;
      }
    }
    this.emit();
    this.pump();
    this.ensurePolling();
  }

  // ------------------------------------------------------------------ scheduling

  private pump(): void {
    if (this.disposed || !this.galleryId) return;
    for (const item of this.items.values()) {
      if (this.active.size >= this.concurrency.limit) break;
      if (item.state === 'queued' && !this.active.has(item.clientId)) void this.run(item);
    }
  }

  private async run(item: Item): Promise<void> {
    const controller = new AbortController();
    item.controller = controller;
    item.state = 'uploading';
    item.error = null;
    this.active.add(item.clientId);
    this.persist(item);
    this.emit();
    try {
      await this.upload(item, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        // Cancelled/removed by the user, or the engine was disposed: a disposed upload goes
        // back to the queue so `activate` (or a reload, via the store) can pick it up again.
        if (item.state === 'uploading') {
          item.state = 'queued';
          item.needsReconcile = item.intentId !== null;
        }
      } else {
        this.fail(item, toItemError(error));
      }
    } finally {
      this.active.delete(item.clientId);
      if (item.controller === controller) item.controller = null;
      if (!this.disposed) {
        this.emit();
        this.pump();
      }
    }
  }

  private async upload(item: Item, signal: AbortSignal): Promise<void> {
    const file = item.file;
    if (!file) throw new UploadFailure(INTERRUPTED);
    const checksum = this.hasher ? this.hasher(file, signal) : Promise.resolve(null);
    checksum.catch(() => {}); // awaited later; never an unhandled rejection

    if (item.intentId && item.needsReconcile) {
      if ((await this.reconcile(item, signal)) === 'completed') return;
    }
    if (!item.intentId) await this.createIntent(item, signal);
    await this.uploadParts(item, file, signal);
    await this.complete(item, file, checksum, signal);
  }

  private async createIntent(item: Item, signal: AbortSignal): Promise<void> {
    const galleryId = this.galleryId!;
    this.intentsInFlight++;
    let result;
    try {
      result = await this.withRetry(
        () =>
          this.api.createIntent(
            galleryId,
            {
              filename: item.name,
              mime: item.mime ?? 'image/jpeg',
              size: item.size,
              clientId: item.clientId,
            },
            signal,
          ),
        signal,
      );
    } catch (error) {
      if (error instanceof UploadApiError) this.handleIntentError(item, error);
      throw error;
    } finally {
      this.intentsInFlight--;
    }
    const { intent, created } = result;
    item.intentId = intent.intentId;
    item.mediaId = intent.mediaId;
    item.plan = planFromReservation(item.size, intent.partSize);
    item.completedParts.clear();
    item.bytesUploaded = 0;
    item.needsReconcile = false;
    if (created && this.quota && !item.quotaCounted) {
      this.quota.reservedFiles += 1;
      this.quota.reservedBytes += item.size;
      item.quotaCounted = true;
    }
    this.persist(item);
  }

  private handleIntentError(item: Item, error: UploadApiError): void {
    if (error.code === 'quota_exceeded' && error.details.requiresAuth) {
      const reason =
        error.details.reason === 'guest_byte_limit' ? 'guest_byte_limit' : 'guest_file_limit';
      this.setAuthPrompt(reason, error.message);
      throw new UploadFailure({
        code: 'quota_exceeded',
        message: 'Sign in to upload more photos.',
        retryable: true,
        requiresAuth: true,
      });
    }
    if (error.status === 401) {
      this.setAuthPrompt(
        error.details.reason === 'draft_expired' ? 'draft_expired' : 'unauthenticated',
        error.message,
      );
      throw new UploadFailure({
        code: 'unauthenticated',
        message: 'Sign in to keep uploading.',
        retryable: true,
        requiresAuth: true,
      });
    }
    if (error.status === 404) {
      throw new UploadFailure({
        code: 'not_found',
        message: 'This gallery is no longer available.',
        retryable: false,
      });
    }
  }

  private setAuthPrompt(reason: AuthPrompt['reason'], message: string): void {
    this.authPrompt = { reason, message };
  }

  /** Brings local part state in line with what R2 actually holds (`GET /uploads/{id}`). */
  private async reconcile(
    item: Item,
    signal: AbortSignal,
  ): Promise<'pending' | 'completed' | 'restart'> {
    let state;
    try {
      state = await this.withRetry(() => this.api.getUpload(item.intentId!, signal), signal);
    } catch (error) {
      if (error instanceof UploadApiError && error.status === 404) {
        this.restartIntent(item);
        return 'restart';
      }
      if (error instanceof UploadApiError && error.status === 401)
        this.handleIntentError(item, error);
      throw error;
    }
    item.needsReconcile = false;
    item.mediaId = state.mediaId;
    if (state.status === 'completed') {
      this.markUploaded(item, state.mediaStatus);
      return 'completed';
    }
    if (state.status !== 'pending') {
      this.restartIntent(item);
      return 'restart';
    }
    const plan = planFromReservation(state.size, state.partSize);
    item.plan = plan;
    item.completedParts = new Map(
      state.parts
        .filter(
          (p) => p.number <= plan.partCount && p.size === partLength(plan, state.size, p.number),
        )
        .map((p) => [p.number, p.etag]),
    );
    item.bytesUploaded = completedBytes(item);
    this.persist(item);
    return 'pending';
  }

  /** The old intent is gone (aborted/expired): start over with a fresh clientId. */
  private restartIntent(item: Item): void {
    void this.store?.deleteUpload(item.clientId).catch(() => {});
    item.clientId = this.reKey(item);
    item.intentId = null;
    item.mediaId = null;
    item.plan = null;
    item.completedParts.clear();
    item.bytesUploaded = 0;
    item.needsReconcile = false;
    item.quotaCounted = false;
  }

  private reKey(item: Item): string {
    const old = item.clientId;
    const next = this.createClientId();
    this.items.delete(old);
    this.items.set(next, item);
    if (this.active.delete(old)) this.active.add(next);
    return next;
  }

  private async uploadParts(item: Item, file: File, signal: AbortSignal): Promise<void> {
    const plan = item.plan!;
    const signed = new Map<
      number,
      { url: string; headers: Record<string, string>; expiresAt: number }
    >();
    const missing = () => {
      const out: number[] = [];
      for (let n = 1; n <= plan.partCount; n++) if (!item.completedParts.has(n)) out.push(n);
      return out;
    };

    for (const partNumber of missing()) {
      for (let attempt = 0; ; attempt++) {
        let part = signed.get(partNumber);
        if (!part || part.expiresAt - this.now() < 60_000) {
          const batch = missing()
            .filter((n) => n >= partNumber)
            .slice(0, this.signBatchSize);
          const parts = await this.withRetry(
            () => this.api.signParts(item.intentId!, batch, signal),
            signal,
          ).catch((error: unknown) => {
            if (error instanceof UploadApiError && (error.status === 401 || error.status === 404)) {
              this.handleIntentError(item, error);
            }
            if (error instanceof UploadApiError && error.status === 409) {
              // Intent expired or aborted server-side: a fresh one is needed.
              this.restartIntent(item);
              throw new UploadFailure({
                ...INTERRUPTED,
                message: 'This upload expired. Retry to start it again.',
              });
            }
            throw error;
          });
          for (const p of parts) {
            signed.set(p.partNumber, {
              url: p.url,
              headers: p.headers,
              expiresAt: Date.parse(p.expiresAt),
            });
          }
          part = signed.get(partNumber);
          if (!part) throw new UploadFailure(INTERRUPTED);
        }

        const start = (partNumber - 1) * plan.partSize;
        const length = partLength(plan, item.size, partNumber);
        const base = completedBytes(item);
        const startedAt = this.now();
        const result = await this.transport({
          url: part.url,
          headers: part.headers,
          body: file.slice(start, start + length),
          signal,
          timeoutMs: this.partTimeoutMs,
          onProgress: (loaded) => {
            item.bytesUploaded = base + Math.min(loaded, length);
            this.emitProgress();
          },
        });

        const okStatus = result.status >= 200 && result.status < 300;
        if (okStatus && (result.etag || !plan.multipart)) {
          item.completedParts.set(partNumber, result.etag ?? '');
          item.bytesUploaded = base + length;
          this.concurrency.onSuccess();
          const seconds = Math.max(0.001, (this.now() - startedAt) / 1000);
          if (length / seconds < this.slowBytesPerSecond) this.concurrency.onError();
          this.persist(item);
          this.emit();
          break;
        }
        if (okStatus) {
          // 2xx without a readable ETag: the bucket CORS rule doesn't expose it. Not retryable.
          throw new UploadFailure({
            code: 'etag_unavailable',
            message:
              'Storage is misconfigured, so this upload can’t finish. Please contact support.',
            retryable: false,
          });
        }

        item.bytesUploaded = base;
        signed.delete(partNumber); // re-sign: the URL may have expired or been rejected
        this.concurrency.onError();
        this.emit();
        if (attempt + 1 >= this.maxPartAttempts) throw new UploadFailure(INTERRUPTED);
        await sleep(
          result.retryAfterMs ?? backoffDelay(attempt, this.random, this.backoff),
          signal,
        );
      }
    }
  }

  private async complete(
    item: Item,
    file: File,
    checksumPromise: Promise<string | null>,
    signal: AbortSignal,
  ): Promise<void> {
    const checksum = await checksumPromise;
    for (let round = 0; ; round++) {
      const parts = item.plan!.multipart
        ? [...item.completedParts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([number, etag]) => ({ number, etag }))
        : [];
      try {
        const result = await this.withRetry(
          () =>
            this.api.complete(item.intentId!, checksum ? { parts, checksum } : { parts }, signal),
          signal,
        );
        this.markUploaded(item, result.mediaStatus);
        return;
      } catch (error) {
        if (!(error instanceof UploadApiError) || error.status !== 409 || round >= 2) throw error;
        const reason = error.details.reason;
        if (reason === 'completed') {
          this.markUploaded(item, 'uploaded');
          return;
        }
        if (
          reason !== 'part_mismatch' &&
          reason !== 'object_missing' &&
          reason !== 'size_mismatch' &&
          reason !== 'no_parts'
        ) {
          throw error;
        }
        // R2 disagrees with our part list: take its view, re-upload what's missing, try again.
        if (reason === 'size_mismatch') item.completedParts.clear();
        else if ((await this.reconcile(item, signal)) === 'completed') return;
        if (!item.intentId) await this.createIntent(item, signal);
        await this.uploadParts(item, file, signal);
      }
    }
  }

  private markUploaded(item: Item, mediaStatus: MediaStatus): void {
    item.state = stateFromMedia(
      mediaStatus === 'reserved' || mediaStatus === 'uploading' ? 'uploaded' : mediaStatus,
    );
    item.bytesUploaded = item.size;
    item.error = item.state === 'failed' ? processingFailed() : null;
    this.persist(item);
    this.emit();
    this.ensurePolling();
  }

  /**
   * Retries `fn` on transient failures (no response, 5xx, 429) with jittered capped backoff,
   * honouring `Retry-After`. Everything else is thrown to the caller.
   */
  private async withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (isAbortError(error) || !(error instanceof UploadApiError) || !error.transient)
          throw error;
        if (attempt + 1 >= this.maxRequestAttempts) throw error;
        this.concurrency.onError();
        this.emit();
        await sleep(error.retryAfterMs ?? backoffDelay(attempt, this.random, this.backoff), signal);
      }
    }
  }

  private fail(item: Item, error: UploadItemError): void {
    if (item.state === 'cancelled' || item.state === 'removed') return;
    item.state = 'failed';
    item.error = error;
    item.bytesUploaded = completedBytes(item);
    this.persist(item);
    if (error.code === 'quota_exceeded' && this.authPrompt?.reason === 'guest_file_limit') {
      // Every other file would hit the same file-count limit: don't spend requests on them.
      for (const other of this.items.values()) {
        if (other.state === 'queued' && !other.intentId) this.failQuota(other, this.authPrompt);
      }
    }
  }

  private failQuota(item: Item, prompt: AuthPrompt): void {
    this.authPrompt = prompt;
    item.state = 'failed';
    item.error = {
      code: 'quota_exceeded',
      message: 'Sign in to upload more photos.',
      retryable: true,
      requiresAuth: true,
    };
    this.persist(item);
  }

  /** Local check against the guest limits before reserving (20 files / 250 MB). */
  private guestQuotaBlock(item: Item): AuthPrompt | null {
    if (!this.quota) return null;
    let files = this.quota.reservedFiles;
    let bytes = this.quota.reservedBytes;
    for (const other of this.items.values()) {
      if (other === item || other.quotaCounted) continue;
      if (ACTIVE.has(other.state) && !other.intentId) {
        files += 1;
        bytes += other.size;
      }
    }
    if (files + 1 > this.quota.maxFiles) {
      return {
        reason: 'guest_file_limit',
        message: 'Guest drafts are limited to 20 photos. Sign in to upload more.',
      };
    }
    if (bytes + item.size > this.quota.maxBytes) {
      return {
        reason: 'guest_byte_limit',
        message: 'Guest drafts are limited to 250 MB. Sign in to upload more.',
      };
    }
    return null;
  }

  private releaseServerReservation(item: Item): void {
    // A photo that failed processing was fully uploaded: deleting it is DELETE /media (T15).
    if (item.intentId && item.error?.code !== 'processing_failed') {
      const intentId = item.intentId;
      void this.api.abort(intentId).catch(() => {});
      if (this.quota && item.quotaCounted) {
        this.quota.reservedFiles = Math.max(0, this.quota.reservedFiles - 1);
        this.quota.reservedBytes = Math.max(0, this.quota.reservedBytes - item.size);
        item.quotaCounted = false;
      }
    }
  }

  // ------------------------------------------------------------------ persistence

  private persist(item: Item): void {
    if (!this.store || !this.galleryId) return;
    if (item.clientId === item.mediaId && item.lastModified === 0) return; // server-hydrated
    const status: StoredUploadRef['status'] =
      item.state === 'queued' || item.state === 'awaiting_file'
        ? 'queued'
        : item.state === 'uploading'
          ? 'uploading'
          : DONE.has(item.state)
            ? 'uploaded'
            : item.state === 'failed'
              ? 'failed'
              : 'cancelled';
    const ref: StoredUploadRef = {
      clientId: item.clientId,
      galleryId: this.galleryId,
      intentId: item.intentId,
      mediaId: item.mediaId,
      name: item.name,
      size: item.size,
      type: item.type,
      lastModified: item.lastModified,
      completedParts: [...item.completedParts.entries()]
        .filter(([, etag]) => etag.length > 0)
        .map(([number, etag]) => ({ number, etag })),
      status,
      updatedAt: this.now(),
    };
    const store = this.store;
    const write = item.state === 'ready' ? store.deleteUpload(item.clientId) : store.putUpload(ref);
    void write.catch(() => {});
  }

  // ------------------------------------------------------------------ processing status

  private ensurePolling(): void {
    if (this.disposed || this.pollTimer) return;
    if (![...this.items.values()].some((i) => POLLED.has(i.state))) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.pollDelay);
  }

  /**
   * Processing → ready (PRD §4). Guests read the whole draft in one request; owners read
   * `GET /uploads/{id}` for a few items per tick.
   * TODO(T15): switch owners to the gallery detail endpoint once it exists.
   */
  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (this.disposed) return;
    let changed = false;
    let stop = false;
    try {
      if (this.mode === 'guest') {
        const draft = await this.api.getGuestDraft();
        this.setGuestQuota(draft.quota);
        const byId = new Map(draft.media.map((m) => [m.id, m.status]));
        for (const item of this.items.values()) {
          if (!POLLED.has(item.state) || !item.mediaId) continue;
          const status = byId.get(item.mediaId);
          if (status) changed = this.applyMediaStatus(item, status) || changed;
        }
      } else {
        const due = [...this.items.values()]
          .filter((i) => POLLED.has(i.state) && i.intentId)
          .sort((a, b) => a.lastPolledAt - b.lastPolledAt)
          .slice(0, this.ownerPollBatch);
        for (const item of due) {
          item.lastPolledAt = this.now();
          const state = await this.api.getUpload(item.intentId!);
          changed = this.applyMediaStatus(item, state.mediaStatus) || changed;
        }
      }
    } catch (error) {
      // 401/404: the draft was claimed or expired, or this session lost access. Stop quietly.
      if (error instanceof UploadApiError && (error.status === 401 || error.status === 404))
        stop = true;
    }
    if (changed) this.emit();
    this.pollDelay = changed
      ? this.pollIntervalMs
      : Math.min(this.maxPollIntervalMs, Math.round(this.pollDelay * 1.5));
    if (!stop) this.ensurePolling();
  }

  private applyMediaStatus(item: Item, status: MediaStatus): boolean {
    if (status === 'reserved' || status === 'uploading') return false;
    if (status === 'deleting' || status === 'deleted') {
      item.state = 'removed';
      void this.store?.deleteUpload(item.clientId).catch(() => {});
      return true;
    }
    const next = stateFromMedia(status);
    if (next === item.state) return false;
    item.state = next;
    item.error = next === 'failed' ? processingFailed() : null;
    this.persist(item);
    return true;
  }
}

function stateFromMedia(status: MediaStatus): UploadState {
  switch (status) {
    case 'processing':
      return 'processing';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'deleting':
    case 'deleted':
      return 'removed';
    default:
      return 'uploaded';
  }
}

function processingFailed(): UploadItemError {
  return {
    code: 'processing_failed',
    message: 'Lumra couldn’t process this photo. Remove it and try a JPEG export.',
    retryable: false,
  };
}

function completedBytes(item: Item): number {
  if (!item.plan) return 0;
  let total = 0;
  for (const n of item.completedParts.keys()) total += partLength(item.plan, item.size, n);
  return total;
}

function toItemError(error: unknown): UploadItemError {
  if (error instanceof UploadFailure) return error.itemError;
  if (error instanceof UploadApiError) {
    if (error.code === 'quota_exceeded') {
      return { code: error.code, message: error.message, retryable: false };
    }
    if (error.code === 'spend_cap_reached' || error.code === 'forbidden') {
      return { code: error.code, message: error.message, retryable: false };
    }
    return {
      code: error.code,
      message: error.transient ? INTERRUPTED.message : error.message,
      retryable: error.transient || error.retryable,
    };
  }
  return INTERRUPTED;
}
