import { ok, newRequestId } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Sanitized liveness probe — never includes config, versions of dependencies or secrets. */
export function GET() {
  return ok({ status: 'ok' }, newRequestId(), { headers: { 'Cache-Control': 'no-store' } });
}
