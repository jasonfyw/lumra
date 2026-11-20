/**
 * Gallery analytics rules (FR-N02, T26). Pure and Web-API-only so the web app and any Worker
 * share them. Nothing here sees or stores a raw IP: callers pass an already truncated network
 * prefix, and only a salted, daily-rotating, per-gallery HMAC leaves this module.
 */

/** One eligible view per anonymous visitor per gallery per window (FR-N02). */
export const VIEW_WINDOW_SECONDS = 30 * 60;

/** `floor(epoch_seconds / 1800)`, stored as `gallery_events.window_bucket`. */
export function viewWindowBucket(now: Date): number {
  return Math.floor(now.getTime() / 1000 / VIEW_WINDOW_SECONDS);
}

// Deliberately simple: well-known crawler/preview/monitoring tokens plus generic markers.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrape|fetch|headless|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|curl\/|wget\/|python-requests|go-http-client|okhttp|axios|java\//i;

/** True for an obvious bot, or a missing/empty User-Agent (real browsers always send one). */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim();
  if (!ua) return true;
  return BOT_PATTERN.test(ua);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Anonymous visitor id for `galleryId`: `HMAC-SHA256(pepper, day | gallery | visitorSignal)`,
 * hex, 32 chars. `visitorSignal` is a coarse network prefix plus the User-Agent (no raw IP). The
 * day rotates the id, so it cannot follow a person across days, and the gallery binds it so it
 * cannot follow one across galleries.
 */
export async function anonymousVisitorHash(
  pepper: string,
  galleryId: string,
  visitorSignal: string,
  now: Date,
): Promise<string> {
  if (!pepper) throw new Error('analytics pepper is required');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `lumra-analytics-v1|${utcDay(now)}|${galleryId}|${visitorSignal}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
