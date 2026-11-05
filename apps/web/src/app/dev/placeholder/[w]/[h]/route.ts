/**
 * Dev-only deterministic placeholder images for the gallery fixture (T17/T18):
 * `GET /dev/placeholder/{w}/{h}?s=<seed>[&download=1]` → SVG. 404 in production.
 */

const MAX_DIMENSION = 8192;

function dimension(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_DIMENSION ? value : null;
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

function placeholderSvg(width: number, height: number, seed: number): string {
  const hue = (seed * 47) % 360;
  const hue2 = (hue + 40) % 360;
  const fontSize = Math.max(10, Math.round(Math.min(width, height) / 8));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 32% 74%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue2} 28% 48%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="rgba(255,255,255,0.85)" font-family="sans-serif" ` +
    `font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle">${seed}</text>` +
    `</svg>`
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ w: string; h: string }> },
): Promise<Response> {
  if (process.env.NODE_ENV === 'production') return notFound();
  const { w, h } = await params;
  const width = dimension(w);
  const height = dimension(h);
  if (width === null || height === null) return notFound();

  const search = new URL(request.url).searchParams;
  const seedRaw = search.get('s') ?? '0';
  const seed = /^\d{1,6}$/.test(seedRaw) ? Number(seedRaw) : 0;

  const headers: Record<string, string> = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'",
  };
  if (search.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="lumra-placeholder-${seed}.svg"`;
  }
  return new Response(placeholderSvg(width, height, seed), { headers });
}
