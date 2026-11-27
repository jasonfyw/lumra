# 010. Short gallery slugs (8 characters), legacy 17-character slugs stay valid

Status: Accepted · Date: 2026-11-20 · Task: FR-G01 / FR-V01 follow-up (short gallery slugs)

## Context

`/g/[slug]` URLs used a 17-character base58 slug (~99.6 bits, chosen to meet a >= 96-bit target).
They are long to read out, paste and print. Some owners have already sent 17-character links to
clients, so those links must keep working forever. Adobe Lightroom's share links use 7
characters; we want shorter URLs without becoming trivially guessable.

## Decision

- New galleries get an **8-character** base58 slug (same Bitcoin alphabet, 58^8 ~ 1.28e14,
  ~46.9 bits). Generation is unchanged otherwise: `crypto.getRandomValues` with rejection
  sampling (bytes >= 232 are discarded), so there is no modulo bias.
- The accepted format is **exactly** 8 or 17 base58 characters, defined once in
  `packages/contracts/src/slug.ts` (`isSlugShape`, `gallerySlugSchema`, `SLUG_LENGTH`,
  `LEGACY_SLUG_LENGTH`) and re-exported by `@lumra/domain` (`isValidSlug`, `generateSlug`).
  Legacy 17-character slugs are never regenerated or migrated.
- `findViewableGallery` (the single lookup behind the public gallery page, API, media-token,
  unlock and archive routes) now rejects anything that is not 8 or 17 base58 characters with the
  same `not_found` as an unknown slug, before touching the database. Previously it accepted
  `[A-Za-z0-9_-]{1,64}`. The public gallery and archive response contracts validate `slug` with
  `gallerySlugSchema`.
- **No migration.** The existing CHECK (`slug ~ '^[A-Za-z0-9_-]{8,64}$'`, core schema migration)
  already admits both 8 and 17 characters, and `packages/db/src/schema.ts` carries no length
  constraint, so nothing needs relaxing. Old migrations are untouched; the DB stays deliberately
  looser than the application format (it is a backstop, not the format authority).
- **Collisions.** `galleries.slug` is `UNIQUE`. With 8 characters a collision is rare but
  possible (birthday bound ~ 50% at ~1.2e7 galleries), so both creation paths
  (`createGalleryForOwner`, `createGuestDraft`) go through `withSlugRetry`
  (`apps/web/src/server/slug-retry.ts`): on a unique violation (`23505`) the whole transaction is
  retried with a fresh slug, up to 3 attempts (a unique violation aborts the surrounding
  transaction, so a retry cannot happen inside it).
- Workers (`apps/media-gateway`, `apps/worker`, `apps/image-processor`) do not parse slugs; media
  tokens and archive jobs are keyed by gallery/media IDs, so no Worker change is needed.

## Enumeration hardening

All public lookup paths are already rate limited per client IP (`RATE_LIMITS`, `packages/config`),
and the limiter runs before the slug is looked up, so 404 guesses are counted:

| Path                                                | Rule                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/g/[slug]` page, `GET .../public/galleries/{slug}` | `publicGalleryRead`: 120 / 60 s per IP                                                                      |
| `POST .../{slug}/unlock`                            | `galleryUnlock`: 10 / 15 min per IP (+ challenge at 5); `galleryUnlockPerGallery`: 300 / 15 min per gallery |
| `POST .../{slug}/media-tokens`                      | `publicMediaTokens`: 240 / 60 s per IP                                                                      |
| `POST .../{slug}/archives`                          | `publicArchiveCreate`: 20 / 60 min per IP                                                                   |

Unknown, draft and deleted galleries are indistinguishable (`not_found`), and the page is
`noindex`. No new limiter was added. Rough exposure: with 1,000,000 published galleries a single
guess hits one with probability ~7.8e-9; at 120 guesses/min one IP makes ~172,800 guesses/day,
i.e. ~0.13% chance per IP-day of landing on any gallery (and only a hit on an unprotected
gallery reveals content). A distributed attacker scales this linearly with the number of IPs, so
this is a deliberate trade-off, not a guarantee: 8 characters protect against casual guessing,
not a determined botnet. Password-protected galleries remain protected by the unlock limits.
Revisit (longer slugs, per-prefix global limits, or WAF rules) if the gallery count grows by
orders of magnitude or scanning is observed.

## Consequences

- Shorter, friendlier URLs (`/g/k3x9AbCd`). Entropy drops from ~99.6 to ~46.9 bits for new
  slugs; the earlier ">= 96 bits" test was replaced by an 8-character/format test.
- Both formats must be accepted everywhere a slug is validated. The regression tests
  (`packages/domain/src/slug.test.ts`, `packages/contracts/src/public-gallery.test.ts`, and the
  e2e spec seeding a 17-character slug) prove a legacy slug still validates and resolves.
- Anything that previously relied on slugs of other shapes (e.g. fixtures with `dev-fixture` or
  hex UUID slugs) must use a valid slug to resolve through the public routes.
- PRD does not hard-code slug length or entropy (FR-G01 only requires a random URL-safe slug),
  so `docs/PRD.md` is unchanged.

## Alternatives considered

- **7 characters (Lightroom):** ~41 bits; shorter but more enumerable. Rejected.
- **Keep 17 characters:** safest, but the URLs are unwieldy.
- **Regenerate or alias old slugs:** breaks, or complicates, links already sent to clients.
- **Add a global per-prefix limiter now:** not needed at current volume; the existing per-IP
  limits use the existing mechanism.
