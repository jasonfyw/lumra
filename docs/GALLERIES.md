# Galleries: editor, publish, password/expiry, delete, share (T15/T16/T19/T21)

Creator-side gallery management. Server logic: `apps/web/src/server/gallery-editor.ts`; routes under
`apps/web/src/app/api/v1/galleries/[id]/`; contracts in `packages/contracts/src/gallery-editor.ts`
(+ `publishGalleryRequestSchema` / `reorderMediaRequestSchema` in `gallery.ts`); rules from
`@lumra/domain` (`GALLERY_TRANSITIONS`, `MEDIA_TRANSITIONS`, `reorder`, `selectCover`,
`checkGalleryExpiry`, `galleryAccessState`).

## Authorization

All endpoints are owner-only (PRD §6.2):

| Caller                                                                    | Result                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------- |
| no credentials                                                            | 401 `unauthenticated`                                    |
| guest capability cookie only                                              | 401 — guests sign in and claim the draft first (J1, T07) |
| signed-in non-owner, unclaimed guest draft, deleted gallery, malformed id | concealed 404                                            |
| foreign `Origin` on a mutation                                            | 403; non-JSON bodies 422                                 |

## Endpoints

| Method | Path                                     | Body → result                                                                                                                                 |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/galleries/{id}`                 | `GalleryDetail`: gallery + every non-deleted item with its internal status (creator sees `failed` tiles), `effectiveCoverMediaId`, `shareUrl` |
| PATCH  | `/api/v1/galleries/{id}`                 | `{title?, coverMediaId?, expiresAt?}` → `GalleryDetail`                                                                                       |
| DELETE | `/api/v1/galleries/{id}`                 | → `{id, status: 'deleted', deletedAt}`                                                                                                        |
| POST   | `/api/v1/galleries/{id}/publish`         | `{expiresAt?, password?}` → `{slug, shareUrl, publishedAt, expiresAt, hasPassword, alreadyPublished}`; 201 first time, 200 replay             |
| PUT    | `/api/v1/galleries/{id}/password`        | `{password: string \| null}` → `{hasPassword, accessVersion}`                                                                                 |
| PATCH  | `/api/v1/galleries/{id}/media/order`     | `{orderedIds}` → `{contentVersion, updated, rebalanced}`                                                                                      |
| DELETE | `/api/v1/galleries/{id}/media/{mediaId}` | → `{mediaId, status: 'deleting', contentVersion, coverMediaId}`                                                                               |

Every mutation locks the gallery row (`SELECT … FOR UPDATE`), so edits, reorders, appends (upload
intents take the same lock) and deletes on one gallery serialise.

## Semantics

- **Title / slug (FR-G01).** Titles are 1–200 chars (trimmed). The slug is generated at creation and
  never changes, so the share URL survives renames and publication.
- **Cover.** `coverMediaId` must be a non-deleted item of this gallery (else 422) or `null` (automatic).
  The hero shown is the override when it is `ready`, otherwise the first ready item by upload order.
- **Expiry (FR-G05).** ISO-8601 UTC (`…Z`) or `null`. Must be in the future and ≤ 10 years ahead
  (`checkGalleryExpiry`), else 422. The UI converts `datetime-local` (browser time) to UTC. "Expired"
  is computed, never stored; extending or removing expiry revives the same URL (J4).
- **Publish (FR-G02, T16).** `draft → published` commits regardless of item readiness and returns
  the share link at once. `published_at` is set once. A replay on a published gallery is idempotent
  (200, `alreadyPublished: true`) and **ignores** the body — change settings with PATCH / PUT password.
  The optional password is hashed with Argon2id before the transaction.
- **Password (FR-G04, T19).** Set, change or remove. Each effective change bumps `access_version`. Gallery
  sessions and media tokens carry the version, so earlier unlocks and tokens stop working. Removing an
  absent password is a no-op.
- **Reorder (FR-G03).** `orderedIds` must be an exact permutation of the current non-deleted items;
  otherwise 409 `conflict` (`retryable: true`, `reason: stale_order`) and the client reloads. `reorder()`
  writes only the rows off the longest increasing run of current keys; when a key would exceed 32 chars
  every item is re-keyed in the same transaction (`rebalanced: true`). Reads order by
  `sort_key COLLATE "C", id`, so pagination is stable. `content_version` is bumped when anything moved.
- **Delete photo.** Media → `deleting` with `deleted_at` (so it leaves the grid, the item count and the
  dashboard's stored bytes immediately). A still-pending upload session is aborted, and a guest
  reservation is released if one exists. The cover override is cleared if it pointed at this item.
  `content_version` is bumped, and a deduped `media.delete` outbox row (`media.delete:{mediaId}`)
  tells the worker to purge the original and derivatives. Plan admission still counts the bytes of
  completed objects until the worker removes them.
- **Delete gallery (FR-G06).** In one transaction: `status = 'deleted'`, `deleted_at`, `access_version + 1`,
  a `gallery.access_changed` row, and a deduped `gallery.delete` row (`gallery.delete:{galleryId}`) for
  the asynchronous purge of originals, derivatives and archives. The gallery is unreachable (public and
  owner) once the transaction commits, which is before the response is sent. The Free-plan gallery slot
  is freed at the same moment. A repeat DELETE is a concealed 404.

## Access-state sync (ADR-001)

`enqueueAccessStateSync(tx, galleryId, requestId)` (`apps/web/src/server/access-state.ts`) writes a
`gallery.access_changed` outbox row **in the same transaction** as every access-relevant change:
publish, password set/change/remove, an expiry change (only when the value really changes), and
deletion. The worker re-reads the gallery and rewrites the KV document `gallery:{id}`. Each row has a
unique dedupe key; the handler is idempotent because it always writes the current DB state. Title,
cover and order changes don't touch access state.

## Editor UI (`/dashboard/galleries/[id]`)

Auth-gated server page (`redirect` to `/auth?returnTo=…`; other users get `notFound()`), rendering
`components/editor/gallery-editor.tsx`:

- inline title edit (Enter saves, Escape cancels);
- `uploadSlot` prop, marked `data-slot="upload-zone"`, where the T14 upload zone mounts;
- photo tiles: ready items show only their owner-scoped thumbnail (no badge); uploading/processing
  items show a spinner overlay (static clock icon under `prefers-reduced-motion`, visually hidden
  label such as "Processing") over the local file preview when the uploader on the page still holds
  the file, otherwise over the neutral shimmer; failed items show an alert icon, "Unavailable / Re-upload
  or delete" and the full message as a tooltip. The tile's accessible name keeps the status. Cover
  toggle, delete with confirmation;
- the uploader reports new media ids to the editor (`UploadBridgeContext`), which refetches so new
  uploads appear in the grid and polling starts;
- reorder by dragging the handle (mouse/pen; long-press on touch) **or** the "Move earlier/later"
  buttons. The order updates optimistically and saves are serialised: the latest order wins, and a
  409 reloads. The grid polls every 5 s while items are still uploading or processing;
- publish panel (optional expiry + password) using `PublishButton`, which now calls the publish API;
- access panel after publication: change or remove expiry, set/change/remove password;
- share sheet (T21): read-only link field, **Copy link** (Clipboard API, falling back to selecting
  the text), **Share…** via the Web Share API when available (falls back to copying; a cancelled
  sheet does nothing), and a QR code rendered from the `qrcode` module matrix as SVG, with
  **Download QR code** as a PNG;
- delete gallery behind a dialog that explains it is irreversible and requires typing "delete".

All controls are ≥ 44 px, keyboard operable, and announced through a polite `aria-live` region.

## Not here

Public gallery reads, the unlock endpoint and session cookie, media tokens and the KV writer belong
to the recipient side and T20. Creator thumbnails are owner-scoped preview tokens minted by the
detail endpoint (ADR-001 "Owner previews").
