/**
 * Sanitized liveness payload shared by `/api/health` (web) and `/health` (Workers):
 * status, service name and — when the deploy provides it — a short commit SHA. Nothing
 * else (no config, dependency versions, env names or secrets).
 */
export interface HealthPayload {
  status: 'ok';
  service: string;
  commit?: string;
}

const SHA = /^[0-9a-f]{7,40}$/i;

export function healthPayload(service: string, commitSha?: string | null): HealthPayload {
  const sha = commitSha?.trim();
  return {
    status: 'ok',
    service,
    ...(sha && SHA.test(sha) ? { commit: sha.slice(0, 12).toLowerCase() } : {}),
  };
}
