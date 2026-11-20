/**
 * Edge cache for preview derivatives (jasonfyw/lumra#83, ADR-001 "Edge cache").
 *
 * The Workers Cache API (`caches.default`) is consulted only **after** the request has been fully
 * authorized. Entries are keyed by the R2 object key — never by the request URL, which carries the
 * token — so every viewer of a derivative shares one entry per Cloudflare data center.
 *
 * Only previews are cached: originals and archives are `no-store` downloads, and Range/HEAD
 * requests bypass the cache and read R2 exactly as before.
 */

/** Synthetic origin for cache keys; never resolvable, never a real request target. */
export const EDGE_CACHE_ORIGIN = 'https://media-cache.lumra.internal';
/** Bump to make every existing entry unreachable on the next deploy (emergency invalidation). */
export const EDGE_CACHE_VERSION = 'v1';
/**
 * Lifetime of an edge entry. Bounds how long cached bytes of a deleted photo can physically
 * outlive the R2 purge (FR-G06: < 24 h); serving them still needs a valid token (≤ 5 min).
 */
export const EDGE_CACHE_TTL_SECONDS = 3600;

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';
export const CACHE_STATUS_HEADER = 'X-Lumra-Cache';

/** The subset of the Workers `Cache` interface the gateway uses. */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * Cache key for an R2 object key, e.g.
 * `https://media-cache.lumra.internal/v1/derivatives/{galleryId}/{mediaId}/{variantHash}`.
 * Derived only from the storage key (itself rebuilt from verified claims), so it can never
 * contain the token, the signature or any request header.
 */
export function edgeCacheKey(objectKey: string): Request {
  const path = objectKey.split('/').map(encodeURIComponent).join('/');
  return new Request(`${EDGE_CACHE_ORIGIN}/${EDGE_CACHE_VERSION}/${path}`, { method: 'GET' });
}

const SIZE_HEADER = 'X-Lumra-Object-Size';

/** Metadata stored with (and read back from) a cached derivative. */
export interface CachedMeta {
  httpEtag: string;
  lastModified: string;
  contentType: string;
  size: number;
}

/**
 * The entry written to the edge cache: the bytes plus the minimum headers needed to rebuild the
 * client response. `public, s-maxage` applies to the edge entry only — the response sent to the
 * client is rebuilt with `private` headers, CORS and security headers on every request.
 */
export function cacheEntry(body: ReadableStream | null, meta: CachedMeta): Response {
  const headers = new Headers({
    'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}, s-maxage=${EDGE_CACHE_TTL_SECONDS}`,
    ETag: meta.httpEtag,
    'Last-Modified': meta.lastModified,
    'Content-Length': String(meta.size),
    // Read back on a hit; does not depend on the runtime preserving Content-Length.
    [SIZE_HEADER]: String(meta.size),
  });
  if (meta.contentType) headers.set('Content-Type', meta.contentType);
  return new Response(body, { status: 200, headers });
}

/** Reads a cached entry back; anything unexpected is treated as a miss. */
export function cachedMeta(response: Response): CachedMeta | null {
  const httpEtag = response.headers.get('ETag');
  const lastModified = response.headers.get('Last-Modified');
  const size = Number(
    response.headers.get(SIZE_HEADER) ?? response.headers.get('Content-Length') ?? NaN,
  );
  if (
    response.status !== 200 ||
    !httpEtag ||
    !lastModified ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return null;
  }
  return {
    httpEtag,
    lastModified,
    contentType: response.headers.get('Content-Type') ?? '',
    size,
  };
}
