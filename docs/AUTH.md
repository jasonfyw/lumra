# Auth, guest claim and dashboard (T05, T07, T08)

Spec: PRD §3 J1/J2, §5.1 FR-A01..A05, §5.2 FR-G01/G07, §5.5 FR-N01, §10, §11. Security model:
ADR-005.

## Sign-in (T05)

Email OTP and magic link only, through Supabase Auth and `@supabase/ssr`.

| Piece                                   | Where                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| `/auth` page (email → 6-digit code)     | `apps/web/src/app/auth/page.tsx`, `auth-form.tsx`            |
| Send / verify / sign-out server actions | `apps/web/src/app/auth/actions.ts`                           |
| Magic-link landing                      | `apps/web/src/app/auth/confirm/route.ts`                     |
| Session cookie refresh                  | `apps/web/src/proxy.ts` (Next 16 proxy, formerly middleware) |
| `returnTo` / intent parsing             | `apps/web/src/lib/return-to.ts`                              |
| Email templates                         | `infra/supabase/templates/*.html` (`config.toml`)            |

- `signInWithOtp` sends one email with the code **and** a link. Its `emailRedirectTo` is
  `${NEXT_PUBLIC_APP_URL}/auth/confirm?returnTo=…[&intent=publish&galleryId=…]`.
- The email template links to `/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}`.
  A `token_hash` link verifies in **any** browser. `/auth/confirm` also accepts Supabase's default
  PKCE `?code=` link, but that link only works in the browser that asked for it.
- `returnTo` is always a same-origin relative path. Absolute URLs, `//host`, `/\host`, control
  characters, `/auth*` and `/api/*` fall back to `/dashboard`. `next` from the email is unwrapped
  only when it points at our own origin.
- Errors are shown in `role="alert"` and status text in an `aria-live` region. Supabase's error text
  is never shown. An invalid or expired link redirects to `/auth?error=link_invalid` and keeps the
  intent.
- Resend has a 60 s cooldown in the UI, matching Supabase `max_frequency`. The profile and the Free
  billing account are created by the `handle_new_user` trigger on first sign-in.
- **Rate limits (FR-A05):** this relies on Supabase Auth's built-in limits for now (`email_sent`,
  `token_verifications`, `max_frequency`). `TODO(rate-limit)` in `actions.ts` marks where the
  app-level per-IP/per-email limiter from `lib/rate-limit.ts` (T06) plugs in.
- **Without Supabase env** (local build, CI, the default e2e run), the proxy does nothing, every
  request counts as signed out, and `/auth` says sign-in is unavailable.
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are required only when
  `VERCEL_ENV` is `production` or `preview`.

## Guest claim and publish flow (T07)

`POST /api/v1/guest/drafts/claim {galleryId}` needs **both** a verified user (`getUser()`) **and**
the guest capability cookie of the session that owns the draft. It runs as one transaction
(`claimGuestDraft` in `apps/web/src/lib/galleries.ts`, rules in `@lumra/domain` `decideClaim`):

1. lock the guest session (`FOR UPDATE`), then the gallery;
2. decide: the session must be unexpired and unclaimed, the gallery must belong to it and not be
   deleted. Every refusal returns a concealed **404**;
3. lock the user's profile and re-check the Free gallery cap (`checkGalleryCreation`). If the cap
   is reached, return **403 `quota_exceeded`** and change nothing;
4. set `galleries.owner_id` and `claimed_at`. `guest_session_id` stays as provenance, as the
   ownership CHECK allows;
5. set `guest_sessions.claimed_by_user_id` and `claimed_at`, then clear the `lumra_guest` cookie.

- **Idempotent:** a repeat claim by the same user returns 200 `alreadyClaimed: true`, with or
  without the spent cookie. For anyone else it is a 404.
- **In-flight uploads:** media and `upload_sessions` hang off the gallery, so they are not
  rewritten. Their ids, keys and reservations stay valid, and T10 authorizes them through the
  gallery's new owner. `pendingUploads` in the response counts them.
- Only the requested gallery is transferred. Other drafts of the same guest session, if any,
  become unreachable when the session is marked claimed (T06 creates one draft per session).
- **UI:** `PublishButton` (`apps/web/src/components/publish-button.tsx`) is meant to be mounted by
  the draft screens (`/new` in T06, the editor in T15). A signed-out guest goes to
  `/auth?intent=publish&galleryId=…&returnTo=…`. After sign-in, `/auth` runs `ClaimDraft` and
  returns to `returnTo`. A signed-in user with a guest draft claims it directly. The publish call
  is `TODO(T16)`.
- **Interrupted auth (FR-A04):** if the link or code is used in a browser without the guest
  cookie, `/auth` shows "Return to the browser where you started to finish publishing." Nothing
  transfers by draft id alone. The user then presses Publish again in the original browser.

## Dashboard (T08)

- `GET /api/v1/galleries?cursor&limit` lists the owner's non-deleted galleries, sorted by
  `updated_at DESC, id DESC`. The keyset cursor is base64url `[updated_at µs ISO, id]`
  (`@lumra/contracts` `encodeKeysetCursor`); `limit` is 1–100 (default 25). Each row has
  `status` (draft, published or computed expired), `itemCount` (non-deleted media), `storedBytes`
  (originals in `uploaded|processing|ready` plus variants of non-deleted media), and `views` and
  `downloads`, which stay 0 until T26.
- `POST /api/v1/galleries {title?}` defaults the title to "Untitled gallery", uses a random
  `generateSlug()`, and enforces the Free cap of 2 active galleries (403 `quota_exceeded`), with
  the cap checked under a profile row lock. With `Idempotency-Key`, the gallery id is
  `uuidv8(SHA-256(userId, key))`. A replay returns the same gallery with 200 and
  `Idempotent-Replayed: true`, and concurrent replays create exactly one row. No extra table is
  needed.
- `/dashboard` is server-rendered and auth-gated (redirects to `/auth?returnTo=/dashboard`). It
  shows name, status, items, size, created and updated dates (UTC), copy-link for published
  galleries, older/newest pagination, an empty state, New gallery and Sign out.
- State-changing endpoints refuse a foreign `Origin` (403) and accept only JSON bodies.

## Tests

- `pnpm test`: `return-to`, cursor and contract units, `decideClaim`, the auth route and action
  tests, and the 401 gates.
- `pnpm test:db` (local Supabase) runs `apps/web/test-db/`: claim authorization (no cookie,
  foreign cookie, expired, deleted, cross-origin), the atomic transfer with an in-flight upload,
  idempotency, the cap re-check, concurrent claims, owner-only listing, the gallery cap,
  `Idempotency-Key` (including concurrent replays), and keyset pagination over 1,000 seeded
  galleries with timestamp ties.
- `E2E_SUPABASE=1 pnpm e2e --project auth-supabase` uses the local stack on port 3000 (its
  `site_url`) and reads codes and links from Mailpit. It covers OTP sign-in, the open-redirect
  guard, a wrong code, the magic link in the same browser and in a different one, the guest claim,
  and interrupted auth. The templates in `config.toml` take effect on the next `supabase start`.

## Manual QA

1. `supabase start --workdir infra`, then set the Supabase vars, `DATABASE_URL` and
   `GUEST_CAPABILITY_PEPPER` in `apps/web/.env.local` and run `pnpm --filter @lumra/web dev`.
2. Open `/dashboard`. It redirects to `/auth`. Enter an email, then open Mailpit
   (http://127.0.0.1:54324): one email has both the code and the link.
3. Enter a wrong code and check that the alert is announced. Enter the right code: you land on
   `/dashboard` with the empty state.
4. New gallery opens the editor. Back on `/dashboard`, the row shows Draft and 0 bytes. A third
   gallery on Free is refused.
5. Try `/auth?returnTo=https://evil.example` and sign in: you land on `/dashboard`.
6. Copy the email link into a private window: it signs in there too (token_hash).
7. Sign out from the dashboard.

## Hosted Supabase setup (operator)

- Auth → URL configuration: set Site URL to `NEXT_PUBLIC_APP_URL` and allow
  `https://<app>/auth/confirm**` plus the preview URLs as redirects.
- Auth → Email templates: paste `infra/supabase/templates/magic_link.html` into **Magic Link** and
  **Confirm signup**. Without this, the email has no code and the link only works in the
  requesting browser.
- Auth → Providers → Email: enable it, with no password sign-in. Set OTP length 6 and expiry
  900 s, and configure a production SMTP provider. The built-in sender is rate-limited heavily and
  is not meant for production.
- Auth → Rate limits: review the email-send and verify limits (FR-A05).
