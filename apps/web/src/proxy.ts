import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase auth session cookies before rendering (T05, @supabase/ssr pattern):
 * Server Components can't write cookies, so an expired access token is rotated here and written
 * to both the forwarded request and the response. No authorization happens here: pages and route
 * handlers verify the user with `getUser()` themselves.
 *
 * Reads `process.env` directly (not `serverEnv()`) to stay tiny; without Supabase env this is a
 * no-op so local builds and the e2e smoke work without the stack.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Anonymous visitors carry no Supabase cookie: skip the client entirely.
  if (!url || !key || !request.cookies.getAll().some((c) => c.name.startsWith('sb-'))) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Cache-Control etc. so a CDN never caches a response carrying a refreshed session.
        for (const [header, value] of Object.entries(headers ?? {})) {
          response.headers.set(header, value);
        }
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it loads and, if needed,
  // refreshes the session. Failures fall through as "signed out".
  await supabase.auth.getClaims().catch(() => undefined);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, image optimisation, metadata files and the health probe.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|woff2?)$).*)',
  ],
};
