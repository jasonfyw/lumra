import 'server-only';
import { and, asc, eq, gt, inArray, isNull, notInArray } from 'drizzle-orm';
import { MEDIA_TOKEN, PUBLIC_GALLERY, type MediaTokenKeyring } from '@lumra/config';
import {
  PREVIEW_VARIANTS,
  type MediaStatus,
  type MediaTokensRequest,
  type MediaTokensResponse,
  type MintedMediaUrls,
  type PublicGalleryLookup,
  type PublicGalleryResponse,
  type PublicMediaItem,
  type PublicMediaVariant,
} from '@lumra/contracts';
import {
  galleries,
  galleryAccessSessions,
  media,
  mediaVariants,
  plans,
  profiles,
  type Database,
} from '@lumra/db';
import {
  galleryAccessState,
  sanitizeDownloadFilename,
  selectCover,
  toPublicMediaStatus,
} from '@lumra/domain';
import { signMediaToken } from '@lumra/tokens';
import { ApiFailure, notFoundError } from '@/lib/api';
import { hashGallerySessionToken, isWellFormedSessionToken } from '@/lib/gallery-session';
import { verifyGalleryPassword } from '@/lib/password';

/**
 * Recipient gallery service (T16/T19/T20): shared by the public API routes and the `/g/[slug]`
 * server component, so the page never calls its own HTTP API.
 *
 * Access rules (FR-V01, PRD §6.2): only published, non-deleted, unexpired galleries are visible;
 * unknown/draft/deleted are indistinguishable 404s; expired is a distinct `gallery_expired`
 * (PRD J4). A password-protected gallery reveals nothing until the request carries a gallery
 * session bound to the gallery's *current* `access_version`.
 *
 * Token minting strategy (ADR-001): the payload lists every item but carries preview URLs only
 * for the first `PUBLIC_GALLERY.initialUrlWindow` items in display order plus the hero; the
 * client mints the rest for visible tiles through `media-tokens` (≤ 100 ids per call). Download
 * URLs (`action: 'original'`) are minted on demand only.
 */

export interface MintDeps {
  keyring: MediaTokenKeyring;
  /** Gateway origin (`NEXT_PUBLIC_MEDIA_URL`); URLs are `${mediaBaseUrl}/m/{token}`. */
  mediaBaseUrl: string;
  now?: Date;
}

const SLUG_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const HIDDEN_MEDIA_STATUSES: MediaStatus[] = ['deleting', 'deleted'];

export interface ViewableGallery {
  id: string;
  slug: string;
  title: string;
  coverMediaId: string | null;
  contentVersion: number;
  accessVersion: number;
  passwordHash: string | null;
  brandingVisible: boolean;
}

const expiredError = () =>
  new ApiFailure({
    code: 'gallery_expired',
    message: 'This gallery has expired.',
    retryable: false,
  });

export const passwordRequiredError = () =>
  new ApiFailure({
    code: 'password_required',
    message: 'This gallery is password protected.',
    retryable: false,
  });

/**
 * The gallery behind `slug` if recipients may see it at all; throws `not_found` (unknown, draft,
 * deleted) or `gallery_expired`. Does not check the password.
 */
export async function findViewableGallery(
  db: Database,
  slug: string,
  now: Date = new Date(),
): Promise<ViewableGallery> {
  if (!SLUG_SHAPE.test(slug)) throw notFoundError();
  const [row] = await db
    .select({
      id: galleries.id,
      slug: galleries.slug,
      title: galleries.title,
      status: galleries.status,
      deletedAt: galleries.deletedAt,
      expiresAt: galleries.expiresAt,
      coverMediaId: galleries.coverMediaId,
      contentVersion: galleries.contentVersion,
      accessVersion: galleries.accessVersion,
      passwordHash: galleries.passwordHash,
      brandingVisible: plans.brandingVisible,
    })
    .from(galleries)
    .leftJoin(profiles, eq(profiles.userId, galleries.ownerId))
    .leftJoin(plans, eq(plans.id, profiles.planId))
    .where(eq(galleries.slug, slug))
    .limit(1);
  if (!row || row.deletedAt) throw notFoundError();
  const state = galleryAccessState({ status: row.status, expiresAt: row.expiresAt }, now);
  if (state === 'expired') throw expiredError();
  if (state !== 'published') throw notFoundError();
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    coverMediaId: row.coverMediaId,
    contentVersion: row.contentVersion,
    accessVersion: row.accessVersion,
    passwordHash: row.passwordHash,
    // Unknown plan (e.g. a guest-owned row) shows the badge, like Free.
    brandingVisible: row.brandingVisible ?? true,
  };
}

/** True when the gallery has no password or `sessionToken` is a live session at this version. */
export async function hasGalleryAccess(
  db: Database,
  gallery: ViewableGallery,
  sessionToken: string | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!gallery.passwordHash) return true;
  return (await liveGallerySessionExpiry(db, gallery, sessionToken, now)) !== null;
}

/**
 * Expiry of `sessionToken` when it is a live session for this gallery at its current
 * `access_version`, else null. Archives (T24) copy the session onto their own paths until then.
 */
export async function liveGallerySessionExpiry(
  db: Database,
  gallery: Pick<ViewableGallery, 'id' | 'accessVersion'>,
  sessionToken: string | undefined,
  now: Date = new Date(),
): Promise<Date | null> {
  if (!isWellFormedSessionToken(sessionToken)) return null;
  const [row] = await db
    .select({ expiresAt: galleryAccessSessions.expiresAt })
    .from(galleryAccessSessions)
    .where(
      and(
        eq(galleryAccessSessions.tokenHash, await hashGallerySessionToken(sessionToken)),
        eq(galleryAccessSessions.galleryId, gallery.id),
        // Any password change / revocation bumps access_version, orphaning older sessions.
        eq(galleryAccessSessions.accessVersion, gallery.accessVersion),
        gt(galleryAccessSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row?.expiresAt ?? null;
}

// ---------------------------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------------------------

interface StoredVariant {
  variant: (typeof PREVIEW_VARIANTS)[number];
  width: number;
  variantHash: string;
}

interface InternalItem {
  id: string;
  status: PublicMediaItem['status'];
  width: number | null;
  height: number | null;
  uploadOrder: number;
  filename: string;
  originalKey: string;
  variants: StoredVariant[];
}

function variantHashFromKey(galleryId: string, mediaId: string, key: string): string | null {
  const prefix = `derivatives/${galleryId}/${mediaId}/`;
  if (!key.startsWith(prefix) || !key.endsWith('.webp')) return null;
  const hash = key.slice(prefix.length, -'.webp'.length);
  return /^[a-z0-9]{4,64}$/.test(hash) ? hash : null;
}

/** `originals/{owner_ref}/{gallery}/{media}/source` → owner_ref, or null if it doesn't match. */
export function ownerRefFromKey(galleryId: string, mediaId: string, key: string): string | null {
  const match =
    /^originals\/([A-Za-z0-9-]{8,64})\/([A-Za-z0-9-]{8,64})\/([A-Za-z0-9-]{8,64})\/source$/.exec(
      key,
    );
  if (!match || match[2] !== galleryId || match[3] !== mediaId) return null;
  return match[1] as string;
}

/** Stored preview derivatives per media id (unsorted). Chunked: never one huge IN list. */
async function loadPreviewVariants(
  db: Database,
  galleryId: string,
  mediaIds: readonly string[],
  variants: readonly StoredVariant['variant'][] = PREVIEW_VARIANTS,
): Promise<Map<string, StoredVariant[]>> {
  const variantsByMedia = new Map<string, StoredVariant[]>();
  for (let i = 0; i < mediaIds.length; i += 500) {
    const chunk = mediaIds.slice(i, i + 500);
    const variantRows = await db
      .select({
        mediaId: mediaVariants.mediaId,
        variant: mediaVariants.variant,
        width: mediaVariants.width,
        objectKey: mediaVariants.objectKey,
      })
      .from(mediaVariants)
      .where(
        and(inArray(mediaVariants.mediaId, chunk), inArray(mediaVariants.variant, [...variants])),
      );
    for (const v of variantRows) {
      const variantHash = variantHashFromKey(galleryId, v.mediaId, v.objectKey);
      if (!variantHash) continue;
      const list = variantsByMedia.get(v.mediaId) ?? [];
      list.push({ variant: v.variant as StoredVariant['variant'], width: v.width, variantHash });
      variantsByMedia.set(v.mediaId, list);
    }
  }
  return variantsByMedia;
}

async function loadItems(
  db: Database,
  galleryId: string,
  onlyIds?: readonly string[],
): Promise<InternalItem[]> {
  const conditions = [
    eq(media.galleryId, galleryId),
    isNull(media.deletedAt),
    notInArray(media.status, HIDDEN_MEDIA_STATUSES),
  ];
  if (onlyIds) conditions.push(inArray(media.id, [...onlyIds]));
  const rows = await db
    .select({
      id: media.id,
      status: media.status,
      width: media.width,
      height: media.height,
      filename: media.filename,
      originalKey: media.originalKey,
      createdAt: media.createdAt,
    })
    .from(media)
    .where(and(...conditions))
    .orderBy(asc(media.sortKey), asc(media.id));

  const readyIds = rows.filter((r) => r.status === 'ready').map((r) => r.id);
  const variantsByMedia = await loadPreviewVariants(db, galleryId, readyIds);

  // Upload order = rank by creation time (hero fallback: first ready photo by upload order).
  const byCreation = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  const uploadOrder = new Map(byCreation.map((r, i) => [r.id, i]));

  return rows.map((r) => {
    const variants = (variantsByMedia.get(r.id) ?? []).sort((a, b) => a.width - b.width);
    let status = toPublicMediaStatus(r.status);
    // A "ready" row we cannot display (no dimensions/derivatives) is a neutral unavailable tile.
    if (status === 'ready' && (variants.length === 0 || !r.width || !r.height)) {
      status = 'unavailable';
    }
    return {
      id: r.id,
      status,
      width: r.width,
      height: r.height,
      uploadOrder: uploadOrder.get(r.id) ?? 0,
      filename: r.filename,
      originalKey: r.originalKey,
      variants: status === 'ready' ? variants : [],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// minting
// ---------------------------------------------------------------------------------------------

function gatewayUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/m/${token}`;
}

function expiresAtIso(now: Date): string {
  return new Date(
    Math.floor(now.getTime() / 1000) * 1000 + MEDIA_TOKEN.maxTtlSeconds * 1000,
  ).toISOString();
}

async function mintPreviews(
  gallery: Pick<ViewableGallery, 'id' | 'accessVersion'>,
  item: InternalItem,
  deps: MintDeps,
): Promise<PublicMediaVariant[]> {
  return Promise.all(
    item.variants.map(async (v) => ({
      width: v.width,
      url: gatewayUrl(
        deps.mediaBaseUrl,
        await signMediaToken(
          {
            action: 'preview',
            gallery_id: gallery.id,
            access_version: gallery.accessVersion,
            media_id: item.id,
            variant: v.variant,
            variant_hash: v.variantHash,
          },
          deps.keyring,
          { now: deps.now },
        ),
      ),
    })),
  );
}

async function mintOriginal(
  gallery: Pick<ViewableGallery, 'id' | 'accessVersion'>,
  item: InternalItem,
  deps: MintDeps,
): Promise<string | null> {
  const ownerRef = ownerRefFromKey(gallery.id, item.id, item.originalKey);
  if (!ownerRef) return null;
  const token = await signMediaToken(
    {
      action: 'original',
      gallery_id: gallery.id,
      access_version: gallery.accessVersion,
      media_id: item.id,
      variant: 'original',
      owner_ref: ownerRef,
      filename: sanitizeDownloadFilename(item.filename, 'photo').slice(0, 255),
    },
    deps.keyring,
    { now: deps.now },
  );
  return gatewayUrl(deps.mediaBaseUrl, token);
}

function toPublicItem(item: InternalItem, variants: PublicMediaVariant[]): PublicMediaItem {
  return {
    id: item.id,
    status: item.status,
    width: item.width,
    height: item.height,
    uploadOrder: item.uploadOrder,
    filename: item.filename,
    variants: item.status === 'ready' ? variants : [],
  };
}

export interface LoadOptions {
  sessionToken?: string;
  /** false: no URLs at all (status polling). Default true: initial window + hero. */
  mintUrls?: boolean;
  now?: Date;
}

/**
 * `GET /api/v1/public/galleries/{slug}` and the `/g/[slug]` page. Throws `not_found` /
 * `gallery_expired`; returns `{passwordRequired: true}` while locked.
 */
export async function loadPublicGallery(
  db: Database,
  slug: string,
  deps: Omit<MintDeps, 'now'> | null,
  options: LoadOptions = {},
): Promise<PublicGalleryLookup> {
  const now = options.now ?? new Date();
  const gallery = await findViewableGallery(db, slug, now);
  if (!(await hasGalleryAccess(db, gallery, options.sessionToken, now))) {
    return { passwordRequired: true };
  }
  const items = await loadItems(db, gallery.id);
  const mint = options.mintUrls !== false && deps !== null;

  const window = new Set<string>();
  if (mint) {
    for (const item of items) {
      if (window.size >= PUBLIC_GALLERY.initialUrlWindow) break;
      if (item.status === 'ready') window.add(item.id);
    }
    const cover = selectCover(items, gallery.coverMediaId);
    if (cover) window.add(cover.id);
  }

  const mintDeps = deps ? { ...deps, now } : null;
  const publicItems = await Promise.all(
    items.map(async (item) =>
      toPublicItem(
        item,
        mintDeps && window.has(item.id) ? await mintPreviews(gallery, item, mintDeps) : [],
      ),
    ),
  );

  const response: PublicGalleryResponse = {
    gallery: {
      id: gallery.id,
      slug: gallery.slug,
      title: gallery.title,
      coverMediaId: gallery.coverMediaId,
      brandingVisible: gallery.brandingVisible,
      contentVersion: gallery.contentVersion,
    },
    items: publicItems,
  };
  if (window.size > 0) response.urlsExpireAt = expiresAtIso(now);
  return response;
}

/** `POST /api/v1/public/galleries/{slug}/media-tokens`: permitted viewers only. */
export async function mintMediaTokens(
  db: Database,
  slug: string,
  deps: Omit<MintDeps, 'now'>,
  request: MediaTokensRequest,
  options: { sessionToken?: string; now?: Date } = {},
): Promise<MediaTokensResponse> {
  const now = options.now ?? new Date();
  const gallery = await findViewableGallery(db, slug, now);
  if (!(await hasGalleryAccess(db, gallery, options.sessionToken, now))) {
    throw passwordRequiredError();
  }
  // Scoped to this gallery: ids from other galleries simply aren't found.
  const items = await loadItems(db, gallery.id, request.mediaIds);
  const byId = new Map(items.map((i) => [i.id, i]));
  const mintDeps = { ...deps, now };

  const minted: MintedMediaUrls[] = [];
  const missing: string[] = [];
  for (const id of request.mediaIds) {
    const item = byId.get(id);
    if (!item || item.status !== 'ready') {
      missing.push(id);
      continue;
    }
    if (request.action === 'preview') {
      minted.push({ id, variants: await mintPreviews(gallery, item, mintDeps) });
    } else {
      const downloadUrl = await mintOriginal(gallery, item, mintDeps);
      if (downloadUrl) minted.push({ id, variants: [], downloadUrl });
      else missing.push(id);
    }
  }
  return { expiresAt: expiresAtIso(now), items: minted, missing };
}

// ---------------------------------------------------------------------------------------------
// unlock
// ---------------------------------------------------------------------------------------------

export type UnlockResult =
  { kind: 'no_password' } | { kind: 'unlocked'; galleryId: string; expiresAt: Date };

/**
 * Verifies the password and records a session (token hash only) bound to the current
 * `access_version`. The caller generates the token and sets the cookie. Throws
 * `invalid_password`, `not_found` or `gallery_expired`.
 */
export async function unlockGallery(
  db: Database,
  slug: string,
  password: string,
  sessionToken: string,
  options: { now?: Date; beforeVerify?: (galleryId: string) => Promise<void> } = {},
): Promise<UnlockResult> {
  const now = options.now ?? new Date();
  const gallery = await findViewableGallery(db, slug, now);
  if (!gallery.passwordHash) return { kind: 'no_password' };
  // Per-gallery throttle runs before the (deliberately slow) Argon2 verification.
  await options.beforeVerify?.(gallery.id);
  if (!(await verifyGalleryPassword(password, gallery.passwordHash))) {
    throw new ApiFailure({
      code: 'invalid_password',
      message: 'That password is not correct.',
      retryable: false,
    });
  }
  const expiresAt = new Date(now.getTime() + PUBLIC_GALLERY.sessionTtlMs);
  await db.insert(galleryAccessSessions).values({
    galleryId: gallery.id,
    tokenHash: await hashGallerySessionToken(sessionToken),
    accessVersion: gallery.accessVersion,
    expiresAt,
  });
  return { kind: 'unlocked', galleryId: gallery.id, expiresAt };
}

// ---------------------------------------------------------------------------------------------
// owner thumbnails (editor)
// ---------------------------------------------------------------------------------------------

/**
 * Derivative used for editor tiles: `w640` keeps ~300 CSS px tiles sharp on 2× screens at a
 * fraction of the larger variants' bytes; smaller images (no `w640`) fall back to `w320`.
 */
export const OWNER_THUMBNAIL_VARIANTS = ['w640', 'w320'] as const;

/**
 * Owner-scoped thumbnail URLs for the creator's editor (ADR-001 "Owner previews"), keyed by
 * media id. The CALLER must already have verified that the signed-in user owns this live
 * gallery: this mints regardless of publish/password/expiry. Tokens carry `scope: 'owner'` and
 * the current `access_version`, so the gateway still applies revocation, deletion and delivery
 * suspension; only drafts (no KV document) and expiry are let through for the owner. Items
 * without a stored derivative get no URL.
 */
export async function mintOwnerThumbnails(
  db: Database,
  gallery: { id: string; accessVersion: number },
  readyMediaIds: readonly string[],
  deps: Omit<MintDeps, 'now'>,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (readyMediaIds.length === 0) return urls;
  const variantsByMedia = await loadPreviewVariants(
    db,
    gallery.id,
    readyMediaIds,
    OWNER_THUMBNAIL_VARIANTS,
  );
  await Promise.all(
    readyMediaIds.map(async (mediaId) => {
      const stored = variantsByMedia.get(mediaId) ?? [];
      const pick = OWNER_THUMBNAIL_VARIANTS.map((name) =>
        stored.find((v) => v.variant === name),
      ).find((v) => v !== undefined);
      if (!pick) return;
      const token = await signMediaToken(
        {
          action: 'preview',
          scope: 'owner',
          gallery_id: gallery.id,
          access_version: gallery.accessVersion,
          media_id: mediaId,
          variant: pick.variant,
          variant_hash: pick.variantHash,
        },
        deps.keyring,
        { now },
      );
      urls.set(mediaId, gatewayUrl(deps.mediaBaseUrl, token));
    }),
  );
  return urls;
}
