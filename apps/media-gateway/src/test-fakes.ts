/**
 * In-memory stand-ins for the R2, KV and Queue bindings used by the gateway tests.
 * (`@cloudflare/vitest-pool-workers` does not yet support the repo's Vitest major.)
 * They model only the binding behaviour the gateway relies on.
 */
import type { QueueMessage } from '@lumra/contracts';

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

export class FakeQueue {
  readonly messages: QueueMessage[] = [];
  fail = false;

  async send(message: QueueMessage): Promise<void> {
    if (this.fail) throw new Error('queue unavailable');
    this.messages.push(message);
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
