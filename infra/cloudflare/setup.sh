#!/usr/bin/env bash
# Create Lumra's Cloudflare resources for one environment and apply bucket policy (T09).
#
# Usage:   infra/cloudflare/setup.sh <dev|staging|production>
# Needs:   wrangler (pnpm --filter @lumra/media-gateway exec wrangler ...) logged in to the
#          target account (`wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).
#
# Idempotent: existing buckets/queues are left alone; CORS, lifecycle and r2.dev settings are
# (re)applied every run so the account converges on what is checked in here.
# Names must match apps/media-gateway/wrangler.jsonc and apps/worker/wrangler.jsonc.
#
# Not covered (dashboard only): the presign-only API token for Vercel — see README.md.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  dev | staging) SUFFIX="-$ENV_NAME" ;;
  production) SUFFIX="" ;;
  *)
    echo "usage: $0 <dev|staging|production>" >&2
    exit 64
    ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WRANGLER=(pnpm --dir "$ROOT/apps/media-gateway" exec wrangler)

ORIGINALS="lumra-originals$SUFFIX"
DERIVATIVES="lumra-derivatives$SUFFIX"
ARCHIVES="lumra-temp-archives$SUFFIX"
JOBS="lumra-jobs$SUFFIX"
JOBS_DLQ="lumra-jobs-dlq$SUFFIX"

log() { printf '\n==> %s\n' "$*"; }

ensure_bucket() {
  local name="$1"
  if "${WRANGLER[@]}" r2 bucket info "$name" >/dev/null 2>&1; then
    echo "bucket $name exists"
  else
    "${WRANGLER[@]}" r2 bucket create "$name"
  fi
  # Buckets are private: never serve anything through the public r2.dev URL (PRD §6.2, §11).
  "${WRANGLER[@]}" r2 bucket dev-url disable "$name" --force
}

ensure_queue() {
  local name="$1"
  if "${WRANGLER[@]}" queues info "$name" >/dev/null 2>&1; then
    echo "queue $name exists"
  else
    "${WRANGLER[@]}" queues create "$name"
  fi
}

log "Environment: $ENV_NAME"

log "Buckets"
ensure_bucket "$ORIGINALS"
ensure_bucket "$DERIVATIVES"
ensure_bucket "$ARCHIVES"

log "CORS: browser PUT/HEAD to originals only (derivatives/archives are read via the gateway)"
"${WRANGLER[@]}" r2 bucket cors set "$ORIGINALS" --file "$HERE/cors.originals.$ENV_NAME.json" --force

log "Lifecycle rules"
"${WRANGLER[@]}" r2 bucket lifecycle set "$ORIGINALS" --file "$HERE/lifecycle.originals.json" --force
"${WRANGLER[@]}" r2 bucket lifecycle set "$ARCHIVES" --file "$HERE/lifecycle.temp-archives.json" --force

log "Queues"
ensure_queue "$JOBS_DLQ"
ensure_queue "$JOBS"

log "Verify"
"${WRANGLER[@]}" r2 bucket cors list "$ORIGINALS"
"${WRANGLER[@]}" r2 bucket lifecycle list "$ARCHIVES"
for bucket in "$ORIGINALS" "$DERIVATIVES" "$ARCHIVES"; do
  "${WRANGLER[@]}" r2 bucket dev-url get "$bucket"
done

cat <<EOF

Done. Remaining manual step for $ENV_NAME (dashboard → R2 → Manage API tokens):
  create "lumra-web-presign-$ENV_NAME" with Object Read & Write scoped to bucket $ORIGINALS only,
  then set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_ORIGINALS=$ORIGINALS
  in the matching Vercel environment.
EOF
