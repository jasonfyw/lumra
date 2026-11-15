/**
 * In-memory stand-ins for the R2, KV and Queue bindings used by the gateway tests.
 * (`@cloudflare/vitest-pool-workers` does not yet support the repo's Vitest major.)
 * They model only the binding behaviour the gateway relies on.
 */

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
  etag: string;
  uploaded: Date;
}

export class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: string[] = [];

  put(key: string, bytes: Uint8Array, contentType?: string): void {
    const etag = `etag${this.objects.size}${bytes.length}`;
    this.objects.set(key, {
      bytes,
      etag,
      uploaded: new Date('2026-11-01T00:00:00Z'),
      ...(contentType ? { contentType } : {}),
    });
  }

  private meta(key: string, stored: StoredObject) {
    return {
      key,
      size: stored.bytes.length,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      uploaded: stored.uploaded,
      httpMetadata: stored.contentType ? { contentType: stored.contentType } : {},
    };
  }

  async head(key: string) {
    this.calls.push(`head:${key}`);
    const stored = this.objects.get(key);
    return stored ? this.meta(key, stored) : null;
  }

  async get(
    key: string,
    options?: { onlyIf?: { etagMatches?: string }; range?: { offset: number; length: number } },
  ) {
    this.calls.push(`get:${key}`);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const meta = this.meta(key, stored);
    if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== stored.etag) return meta;
    const slice = options?.range
      ? stored.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : stored.bytes;
    return { ...meta, body: new Blob([slice]).stream() };
  }
}

export class FakeKv {
  readonly data = new Map<string, string>();
  fail = false;
  reads = 0;

  async get(key: string, _type?: 'text'): Promise<string | null> {
    this.reads++;
    if (this.fail) throw new Error('KV unavailable');
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

/** Collects `waitUntil` promises so tests can await background work. */
export class FakeExecutionContext {
  readonly pending: Promise<unknown>[] = [];
  readonly props = {};
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
  passThroughOnException(): void {}
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}

interface CachedEntry {
  bytes: Uint8Array;
  status: number;
  headers: [string, string][];
  expiresAt: number;
}

/**
 * Stand-in for `caches.default`: stores by URL, honours `s-maxage`/`max-age` from the stored
 * response's `Cache-Control` and rejects what the real Cache API rejects (non-GET keys, 206s,
 * `no-store`/`private`). `noop` models `*.workers.dev`, where every call does nothing.
 */
export class FakeCache {
  readonly entries = new Map<string, CachedEntry>();
  readonly calls: string[] = [];
  noop = false;
  failMatch = false;

  async match(request: Request): Promise<Response | undefined> {
    this.calls.push(`match:${request.url}`);
    if (this.failMatch) throw new Error('cache unavailable');
    if (this.noop) return undefined;
    const entry = this.entries.get(request.url);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(request.url);
      return undefined;
    }
    return new Response(entry.bytes.slice(), { status: entry.status, headers: entry.headers });
  }

  async put(request: Request, response: Response): Promise<void> {
    this.calls.push(`put:${request.url}`);
    if (request.method !== 'GET') throw new TypeError('Cache key must be a GET request');
    if (response.status === 206) throw new TypeError('Cannot cache a 206 response');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.noop) return;
    const cc = response.headers.get('Cache-Control') ?? '';
    if (/no-store|private/i.test(cc)) return;
    const ttl = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? /max-age=(\d+)/.exec(cc)?.[1] ?? 0);
    if (ttl <= 0) return;
    this.entries.set(request.url, {
      bytes,
      status: response.status,
      headers: [...response.headers],
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async delete(request: Request): Promise<boolean> {
    this.calls.push(`delete:${request.url}`);
    return this.entries.delete(request.url);
  }
}
