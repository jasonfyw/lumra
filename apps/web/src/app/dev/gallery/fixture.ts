import { DERIVATIVE_WIDTHS, GALLERY_LIMITS } from '@lumra/config';
import type { PublicGalleryResponse, PublicMediaItem } from '@lumra/contracts';

/**
 * Deterministic dev/test fixture for the recipient gallery UI (T17/T18). Images point at the
 * dev-only `/dev/placeholder/{w}/{h}` SVG route, so no external network is needed.
 */

/** [w, h, weight] — mixed aspect ratios including portraits and panoramas. */
const ASPECTS: readonly (readonly [number, number, number])[] = [
  [3, 2, 30],
  [2, 3, 20],
  [4, 3, 12],
  [3, 4, 8],
  [1, 1, 8],
  [16, 9, 10],
  [9, 16, 4],
  [3, 1, 4],
  [4, 1, 2],
  [21, 9, 2],
];
const TOTAL_WEIGHT = ASPECTS.reduce((sum, [, , weight]) => sum + weight, 0);
const LONG_EDGE = 6000;
const NAMES = ['Harbour at dawn', 'Lighthouse', 'Dune grass', 'Tide pools', 'Cliff path'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function pickAspect(r: number): readonly [number, number] {
  let acc = r * TOTAL_WEIGHT;
  for (const [w, h, weight] of ASPECTS) {
    acc -= weight;
    if (acc < 0) return [w, h];
  }
  return [3, 2];
}

export interface FixtureOptions {
  /** Hide the Lumra badge (paid plan). */
  branding?: boolean;
  /** Point the cover override at this item index. */
  coverIndex?: number;
  seed?: number;
}

export function makeGalleryFixture(
  count: number,
  options: FixtureOptions = {},
): PublicGalleryResponse {
  const n = Math.max(0, Math.min(GALLERY_LIMITS.maxItemsPerGallery, Math.floor(count)));
  const random = mulberry32(options.seed ?? 20261105);
  const items: PublicMediaItem[] = [];

  for (let i = 0; i < n; i++) {
    const [aw, ah] = pickAspect(random());
    const statusRoll = random();
    const width = aw >= ah ? LONG_EDGE : Math.round((LONG_EDGE * aw) / ah);
    const height = aw >= ah ? Math.round((LONG_EDGE * ah) / aw) : LONG_EDGE;
    const filename =
      i % 7 === 3
        ? `${NAMES[i % NAMES.length]} ${i + 1}.jpg`
        : `IMG_${String(i + 1).padStart(4, '0')}.jpg`;
    const base = { id: fixtureId(i + 1), uploadOrder: i, filename };

    // Item 0 is still processing, so the hero falls back to the next ready photo.
    if (i === 0 || statusRoll < 0.04) {
      const known = random() < 0.5;
      items.push({
        ...base,
        status: 'pending',
        width: known ? width : null,
        height: known ? height : null,
        variants: [],
      });
      continue;
    }
    if (statusRoll < 0.055) {
      items.push({ ...base, status: 'unavailable', width, height, variants: [] });
      continue;
    }
    items.push({
      ...base,
      status: 'ready',
      width,
      height,
      variants: DERIVATIVE_WIDTHS.filter((w) => w <= width).map((w) => ({
        width: w,
        url: `/dev/placeholder/${w}/${Math.max(1, Math.round((w * height) / width))}?s=${i + 1}`,
      })),
      downloadUrl: `/dev/placeholder/${width}/${height}?s=${i + 1}&download=1`,
    });
  }

  const coverItem = options.coverIndex !== undefined ? items[options.coverIndex] : undefined;
  return {
    gallery: {
      id: fixtureId(0xa11e7),
      slug: 'dev-fixture',
      title: 'Coastline, autumn',
      coverMediaId: coverItem?.id ?? null,
      brandingVisible: options.branding ?? true,
      contentVersion: 1,
    },
    items,
  };
}
