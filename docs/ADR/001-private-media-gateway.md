# 001. Private media gateway vs presigned GETs

Status: Accepted · Date: 2026-11-05 · Task: T20

## Context

Gallery media must not be readable by guessing R2 keys or by bypassing a gallery password with a direct
object URL (FR-V01/V02, PRD §11). Password changes, expiry, billing suspension and deletion must stop new
deliveries quickly, delivery bytes must be metered (FR-D04), and media bytes must never pass through Vercel.

## Decision

**A Cloudflare Worker (`apps/media-gateway`) is the only read path into the private R2 buckets.** It is
served on its `*.workers.dev` URL (no custom media domain while the app lives on `lumra-ten.vercel.app`) and
exposes `GET|HEAD /m/:token`. Per request it:

1. verifies the media token (signature, audience, expiry);
2. loads the gallery's access state and requires `access_version` to match, not deleted, not expired, not
   delivery-suspended;
3. rebuilds the object key from token claims with the `@lumra/media` key builders and streams from the R2
   binding (Range → 206, `If-None-Match` → 304, `If-Range`);
4. emits one `delivery.served` queue message (`USAGE` binding) per byte-bearing response.

Authorization always completes before any R2 read. Every denial is a generic `401` (token), `403`
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
- `exp − iat ≤ 300 s` and `exp − now ≤ 300 s + skew`; 30 s clock skew tolerated; `jti` required (also the
  usage dedupe prefix).
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
  recipient token. Owner previews are delivery like any other preview (one `delivery.served` event).
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
- Never `public`: authorization decisions are not cached in shared caches. Edge caching of immutable
  derivative bytes (Cache API keyed by object key, looked up only **after** authorization, PRD §12) is a
  later optimization and must keep that ordering.
- All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Vary: Origin`. CORS is granted only to exact
  origins in `APP_ORIGIN` (comma-separated); preflight allows `GET, HEAD` and `Range`/`If-*` headers.

### Usage metering

`delivery.served` (`@lumra/contracts` queue schema) carries `galleryId`, `action`, `mediaId` or
`archivePartId`, `variant`, `bytes` (object size, or range length for 206), `servedAt`, `traceId` (`cf-ray`)
and `dedupeKey = {jti}:{start}-{end}`. No event for `HEAD`, `304`, `416` or denials. Sent via `waitUntil`;
a send failure is logged and never fails the response. Bytes are the bytes the response is committed to
send; a client aborting mid-stream is still counted in full (bounded by the object/range size and token TTL).

## Consequences

- **In-flight downloads:** revocation, expiry or deletion stops _new_ requests (including new byte ranges
  of a resumable download). A response already streaming when the state changes may finish; we don't track
  or kill open streams. This is the documented behaviour for PRD §11 "deleted during in-flight download".
- One extra R2 `head` for conditional/range requests; unconditional GETs are a single R2 operation.
- Gallery reads cost one KV read per gallery per isolate per 5 s.
- The web app and gateway share `MEDIA_TOKEN_SECRET`; the gateway never needs DB credentials.
- The `lumra-usage-*` queues need a consumer (usage-ledger ingestion, T27) before launch; until then
  messages wait in the queue.

## Alternatives considered

- **Presigned R2 GET URLs**: no Worker cost, but pure bearer access until expiry with no revocation check,
  no per-response metering, no `Content-Disposition` control without signing response overrides, and the
  gallery password could be bypassed for the URL's lifetime.
- **Asymmetric JWS (EdDSA/ES256)**: lets the gateway hold only a public key, but both sides are ours and
  HMAC is simpler and faster in WebCrypto; `kid` keeps a path to switch later.
- **Durable Object for access state**: strongly consistent, but adds per-request latency to a single
  location and more moving parts; kept as the drop-in upgrade path behind `GalleryAccessStore`.
- **Cookies on the media origin**: the gateway is on a different site (`workers.dev`) than the app, so
  third-party cookie restrictions would break it; path tokens work everywhere and are scoped per item.
