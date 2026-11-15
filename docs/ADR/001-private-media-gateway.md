# 001. Private media gateway vs presigned GETs

Status: Accepted · Date: 2026-11-05 · Task: T20 · Amended 2026-11-13 by ADR-008 (no delivery metering) ·
Amended 2026-11-15 by jasonfyw/lumra#83 (custom domain + edge cache)

## Context

Gallery media must not be readable by guessing R2 keys or by bypassing a gallery password with a direct
object URL (FR-V01/V02, PRD §11). Password changes, expiry, billing suspension and deletion must stop new
deliveries quickly, and media bytes must never pass through Vercel. (Delivery bytes were originally metered,
FR-D04; ADR-008 removed delivery metering.)

## Decision

**A Cloudflare Worker (`apps/media-gateway`) is the only read path into the private R2 buckets.** It is
served on the Workers custom domain `media.lumra.photos` (zone `lumra.photos` on Cloudflare; the app's
apex/`www` records stay DNS-only to Vercel). Its `*.workers.dev` URL stays enabled during the
transition, without edge caching. It exposes `GET|HEAD /m/:token`. Per request it:

1. verifies the media token (signature, audience, expiry);
2. loads the gallery's access state and requires `access_version` to match, not deleted, not expired, not
   delivery-suspended;
3. rebuilds the object key from token claims with the `@lumra/media` key builders;
4. for full-body preview GETs only, looks the object up in the edge cache (see **Edge cache**);
5. otherwise streams from the R2 binding (Range → 206, `If-None-Match` → 304, `If-Range`).

It emits no usage events and has no queue binding (ADR-008; it used to send one `delivery.served` message
per byte-bearing response). `deliverySuspended` means billing suspension only.

Authorization always completes before any edge-cache lookup or R2 read. Every denial is a generic `401` (token), `403`
(revoked/expired/suspended), `404` (deleted/missing) or `503` (state unavailable) with
`Cache-Control: no-store` and no detail in the body; reasons go to structured logs only, never tokens.

### Tokens: HMAC-SHA256 compact JWS with `kid` rotation (`@lumra/tokens`)

- Header `{"alg":"HS256","typ":"JWT","kid":…}`. Anything else (`none`, `RS256`, `HS512`, missing `kid`,
  `crit`) is rejected before any key is used. Signatures are compared in constant time and checked before
  claims are parsed.
- Claims (`mediaTokenClaimsSchema` in `@lumra/contracts`, discriminated on `action`): `aud=lumra-media`,
  `gallery_id`, `access_version`, `iat`, `exp`, `jti`, plus per action the storage-key segments the gateway
  needs so it never touches the database: `preview` → `media_id`, `variant`, `variant_hash`; `original` →
  `media_id`, `variant=original`, `owner_ref`, optional `filename`; `archive` → `archive_part_id`,
  `archive_job_id`, `archive_part_no`, optional `filename`. Segments are re-validated by the key builders.
- `exp − iat ≤ 300 s` and `exp − now ≤ 300 s + skew`; 30 s clock skew tolerated; `jti` required.
- Uses WebCrypto only, so the Next.js server (Node 22) signs and the Worker verifies with the same code.
- **Keyring env (`MEDIA_TOKEN_SECRET`)**: `kid:secret[,kid:secret…]`, each secret ≥ 32 chars, no `,`/`:`
  (e.g. `k2:$(openssl rand -hex 32)`). The web app signs with the **first** entry; the gateway accepts
  **all** entries. A bare secret is accepted as kid `default`. Rotation:
  1. prepend the new key to the gateway's keyring and deploy (`wrangler secret put MEDIA_TOKEN_SECRET`);
  2. prepend it to the web app's keyring and deploy — new tokens now use the new `kid`;
  3. after ≥ 5.5 min (max TTL + skew), remove the old key from both.
     Emergency revocation of a leaked key: remove it from the gateway immediately (outstanding tokens 401).

### Access state: KV mirror with ≤ 5 s memo, fail closed

- Contract `galleryAccessStateSchema` (`@lumra/contracts`): `{accessVersion, deleted, expiresAt,
deliverySuspended, updatedAt}` stored as JSON in KV namespace `ACCESS_STATE`, key `gallery:{galleryId}`.
- Postgres remains authoritative. **Writer (as built, T20):** every access-relevant change (publish,
  password change/revocation — bumps `access_version` —, expiry change, delivery suspension/resumption,
  deletion) calls `enqueueAccessStateSync` inside its DB transaction, which writes a
  `gallery.access_changed` outbox row. The worker relays it to the jobs queue and
  `apps/worker/src/handlers/access-state.ts` re-reads the gallery (and the owner's billing account,
  `deriveBillingRestrictions` → `deliverySuspended`, failing closed on inconsistent billing rows) and
  writes the document through the `ACCESS_STATE` binding with `writeGalleryAccessState`.
  `gallery.delete` writes a tombstone (`deleted: true`); drafts write nothing. Each run writes the
  _current_ DB state, so redelivery and reordering are harmless. `reconcileAccessStates` rewrites all
  published/deleted galleries (lost messages, time-based billing transitions); T13 schedules it. The
  REST target (`{ rest: … }`) remains available for writers outside Workers but is unused, so Vercel
  needs no Cloudflare API token. Worker and gateway must bind the **same** namespace id.
- The gateway reads through `createKvGalleryAccessStore`: an in-isolate memo of at most 5 s (clamped in
  code), errors never memoized. A KV error or schema-invalid document → `503` (fail closed); a missing
  document → `404`. Any `access_version` mismatch (lower = revoked, higher = KV lagging) → `403`.
- **KV propagation caveat:** KV is eventually consistent across locations; a write is visible immediately
  at the writing location but may take up to ~60 s to reach other edge locations' caches. The effective
  revocation bound for an already-issued token is therefore "≤ 5 s memo + KV propagation", and never longer
  than the token's own ≤ 5 min lifetime. New tokens are not minted after a password change because the
  minting endpoint checks Postgres directly. If strict seconds-level global revocation becomes a requirement,
  swap the `GalleryAccessStore` implementation for a Durable Object (strongly consistent) — the interface
  is unchanged.

### Token minting strategy (T16/T20)

- Minting happens only in the web app, after checking Postgres directly (published, not deleted, not
  expired, valid gallery session for passworded galleries); tokens carry the current `access_version`
  and are signed with the **first** keyring entry. TTL is the maximum 300 s.
- **Bounded payloads for 2,000 items:** `GET /api/v1/public/galleries/{slug}` lists every item
  (status, dimensions, filename) but mints preview URLs (one token per derivative, ~4 per item) only
  for the first `PUBLIC_GALLERY.initialUrlWindow` (48) ready items in display order plus the hero —
  ≈ 200 tokens / ~100 kB instead of ~8,000 tokens / ~4 MB. Ready items outside the window arrive
  with `variants: []` (the contract allows this; tiles render a quiet skeleton).
- The client (`PublicGallery`) reports the windowed grid's rendered ids and mints the missing ones via
  `POST …/media-tokens` (`action: 'preview'`, ≤ 100 ids, debounced). A tile keeps the URL it was first
  rendered with; an item is re-minted only when it is needed again and its URL expires within 45 s
  (re-minting on a timer would change `src` and re-download bytes already on screen).
- Download URLs (`action: 'original'`, `owner_ref` from the stored original key, sanitized `filename`)
  are minted only for the item open in the lightbox and refreshed every 30 s while it is open; an
  expired download URL is hidden rather than offered.
- Pending items: the client polls `GET …?urls=0` (statuses only, no signing) every 8 s while any item is
  pending, then mints URLs for tiles that became ready (PRD §14.2-3).
- All public responses are `Cache-Control: private, no-store` and rate limited per IP
  (`publicGalleryRead`, `publicMediaTokens`).

### Owner previews (editor thumbnails)

- The owner's editor (`GET`/`PATCH /api/v1/galleries/{id}` and the `/dashboard/galleries/[id]` page)
  returns one `thumbnailUrl` per `ready` item: a `preview` token for `w640` (else `w320`) carrying
  `scope: 'owner'` and the current `access_version`. It is minted only after the request has been
  authorized as the gallery's owner in Postgres (signed-in Supabase user, `owner_id` match, live
  gallery); every other caller gets the editor's 401/concealed 404 and no URLs.
- The gateway applies the normal rule to owner previews with two relaxations
  (`evaluateGalleryAccess(…, { ownerPreview: true })`): a **missing** KV document is allowed (drafts
  never get one), and **expiry** is ignored (the creator still manages an expired gallery). A
  tombstone (deleted), any `access_version` mismatch and `deliverySuspended` deny owner previews too.
  `scope` exists only on `preview` claims, so originals and archives are unaffected.
- Bounded exposure: a leaked owner token is one derivative of one item for ≤ 5 min, the same as any
  recipient token.
- The editor keeps the URL a tile first rendered with; when an image fails to load (typically an
  expired token on a lazily loaded tile) it refetches the detail once per item per minute and
  swaps in the fresh URL.
- Deploy order: the gateway first. An older gateway ignores `scope` and keeps 404ing draft
  thumbnails (the editor then shows a neutral placeholder); published galleries work either way.

### Cache policy

- Previews: `private, max-age=300`, `inline`, `Content-Type` restricted to `image/*` (else
  `application/octet-stream`). The URL embeds the token, so browser caching never outlives authorization.
- Originals and archives: `private, no-store`, `Content-Disposition: attachment; filename="…";
filename*=UTF-8''…` from the sanitized `filename` claim (last path segment, no control/bidi/reserved
  characters, no leading dots, ≤ 150 code points; archives forced to `.zip`).
- Never `public` to clients: authorization decisions are not cached in shared caches. Only the
  gateway's own edge-cache entry (below) is `public`, and it is never returned as-is.
- All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Vary: Origin`. CORS is granted only to exact
  origins in `APP_ORIGIN` (comma-separated); preflight allows `GET, HEAD` and `Range`/`If-*` headers.

### Edge cache (jasonfyw/lumra#83)

- **What:** preview derivatives only, on full-body `GET`s (with or without `If-None-Match`). Originals
  and archives (`no-store` downloads), `HEAD` and any request with a `Range` header bypass the cache and
  read R2 exactly as before. Implementation: `apps/media-gateway/src/edge-cache.ts`.
- **Ordering:** token verification, access state, `access_version`, deletion tombstone, expiry,
  billing suspension and the owner-scope rules all run first, per request. The cache is consulted only
  once they pass, so revocation, unpublish, expiry, suspension and gallery deletion deny cached media
  exactly as fast as uncached media (≤ 5 s memo + KV propagation). Denials are never cached.
- **Store:** the Workers Cache API (`caches.default`), per Cloudflare data center, not tiered. On a miss
  the R2 body is tee'd: one branch to the client, one to `cache.put` under `ctx.waitUntil`. Workers
  Caching (`"cache": { "enabled": true }`, which caches _in front of_ the Worker) must never be enabled:
  it would skip authorization.
- **Key:** `https://media-cache.lumra.internal/v1/{objectKey}` — derived only from the R2 object key that
  the key builders rebuild from verified claims (`derivatives/{galleryId}/{mediaId}/{variantHash}`), so it
  never contains the token or any request header, and every viewer shares one entry. `access_version`
  and `content_version` are deliberately not part of the key: access is re-checked before every lookup,
  and a changed derivative gets a new `variant_hash` (new key). `v1` is a code constant
  (`EDGE_CACHE_VERSION`); bumping it and deploying makes every existing entry unreachable at once.
- **Entry vs client headers:** the stored entry carries only bytes, `Content-Type`, `ETag`,
  `Last-Modified`, size and `Cache-Control: public, max-age=3600, s-maxage=3600`. The client response is
  rebuilt on every hit with the usual `private, max-age=300`, `inline`, `image/*`-only `Content-Type`,
  CORS for the request's `Origin` and the security headers. `If-None-Match` against the cached `ETag`
  answers `304` without touching R2.
- **Deleted media bound:** the gateway has no per-media deletion check, and `caches.default.delete` is
  per data center (and the purge runs in `apps/worker`, which isn't on the zone), so the T13 purge does
  not evict cache entries. The guarantee rests on two bounds instead:
  1. _Serving_: a cached preview of a deleted photo is served only to a token minted **before** the
     delete (the web app stops minting for `deleting`/`deleted` media), i.e. for ≤ 5 min + 30 s skew —
     the same window as before, when it ended with the R2 purge.
  2. _Physical copy_: each colo's entry expires `EDGE_CACHE_TTL_SECONDS` = **1 h** after it was stored,
     well inside FR-G06's < 24 h physical deletion SLO. Gallery deletion is enforced at once by the
     tombstone and `access_version` bump; its cached bytes also age out within 1 h.
     Emergency removal: Cloudflare dashboard → `lumra.photos` → Caching → Purge Everything (custom-key
     Cache API entries cannot be purged by URL), or bump `EDGE_CACHE_VERSION` and deploy.
- **Where it works:** only on the custom domain. On `*.workers.dev` the Cache API is a no-op, so the
  gateway skips it there (no body tee) and reports `BYPASS`; if `caches` is missing or a lookup throws,
  the request is served from R2 (fail open on cache, never on authorization).
- **Observability:** every served response carries `X-Lumra-Cache: HIT | MISS | BYPASS` and logs
  `media served` with `action`, `status` and `cache` (never object keys or tokens). Hit ratio =
  `HIT / (HIT + MISS)` over `media served` events.
- **Browser cache:** URLs still carry a fresh random `jti` per mint, so a reload re-requests (now an edge
  hit). Stable per-time-bucket tokens (issue item 4) were not adopted: with a 300 s maximum TTL a
  bucketed `iat` shortens each URL's remaining lifetime, which collides with the client's
  "re-mint when < 45 s left" rule, for a small browser-cache gain.

### Usage metering

Removed by ADR-008: delivery is not tracked. (Previously a `delivery.served` event per byte-bearing
response fed the `lumra-usage-*` queues.) Serving cost is uncapped; the edge cache (above) removes the R2 read
for repeat preview views per colo.

## Consequences

- **In-flight downloads:** revocation, expiry or deletion stops _new_ requests (including new byte ranges
  of a resumable download). A response already streaming when the state changes may finish; we don't track
  or kill open streams. This is the documented behaviour for PRD §11 "deleted during in-flight download".
- One extra R2 `head` for conditional/range requests; unconditional GETs are a single R2 operation, and
  an edge-cache hit on a preview is none.
- Cached preview bytes may outlive the R2 purge by up to 1 h per colo (but are only servable with a
  ≤ 5 min token minted before the delete).
- Gallery reads cost one KV read per gallery per isolate per 5 s.
- The web app and gateway share `MEDIA_TOKEN_SECRET`; the gateway never needs DB credentials.
- No usage queue: the `lumra-usage-*` queues are unbound since ADR-008 and can be deleted.

## Alternatives considered

- **Presigned R2 GET URLs**: no Worker cost, but pure bearer access until expiry with no revocation check,
  no per-response metering, no `Content-Disposition` control without signing response overrides, and the
  gallery password could be bypassed for the URL's lifetime.
- **Asymmetric JWS (EdDSA/ES256)**: lets the gateway hold only a public key, but both sides are ours and
  HMAC is simpler and faster in WebCrypto; `kid` keeps a path to switch later.
- **Durable Object for access state**: strongly consistent, but adds per-request latency to a single
  location and more moving parts; kept as the drop-in upgrade path behind `GalleryAccessStore`.
- **Cookies on the media origin**: the gateway started on a different site (`workers.dev`) than the app,
  so third-party cookie restrictions would have broken it; `media.lumra.photos` is same-site now, but
  path tokens work everywhere, are scoped per item and keep the cache key independent of the viewer.
- **Per-media deleted marker in KV, checked before the cache**: a hard deletion guarantee for cached
  bytes, but one more KV write per photo delete and one more KV read per request; the token TTL already
  bounds who can be served.
- **Workers Caching in front of the Worker / zone Cache Rules**: would cache before authorization.
