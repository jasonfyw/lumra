# Cloudflare

Worker configs live next to their code (`apps/media-gateway/wrangler.jsonc`, `apps/worker/wrangler.jsonc`).
This directory holds account-level resources that are created once per environment (T09).

## Resources per environment (`dev`, `staging`, `production`)

Production names have no suffix (`lumra-originals`); dev/staging append `-<env>`. These must
match the bucket/queue names in the two `wrangler.jsonc` files.

| Resource  | Name pattern                                | Notes                                                                                     |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R2 bucket | `lumra-originals[-<env>]`                   | Private. CORS: `PUT`/`HEAD` from app origins only. Aborts stale multipart uploads (2 d).  |
| R2 bucket | `lumra-derivatives[-<env>]`                 | Private. No CORS. Read only through the media gateway binding.                            |
| R2 bucket | `lumra-temp-archives[-<env>]`               | Private. No CORS. Lifecycle: delete objects after 1 day (FR-D04).                         |
| Queue     | `lumra-jobs[-<env>]` + `lumra-jobs-dlq[-…]` | Messages carry IDs only.                                                                  |
| API token | `lumra-web-presign-<env>`                   | Object Read & Write on `originals` only; used by Vercel to presign PUTs (dashboard step). |
| Gateway   | `lumra-media-gateway` on `*.workers.dev`    | No custom media domain while the app runs on `lumra.vercel.app`.                          |

No bucket has `r2.dev` public access or a custom domain: the only read path is the media gateway
(R2 binding), and the only write path from browsers is a presigned URL (PRD §6.1–6.2, §11).

## Files

| File                           | Applied to      | Purpose                                                                                                                                                                                                                           |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cors.originals.<env>.json`    | originals       | Allow `PUT`/`HEAD` with `content-type` from the env's app origin only (dev/staging: `http://localhost:3000`; production: `https://lumra.vercel.app`); expose `ETag` (needed to complete multipart uploads); preflight cached 1 h. |
| `lifecycle.originals.json`     | originals       | Abort incomplete multipart uploads after 2 days (abandoned uploads still bill storage).                                                                                                                                           |
| `lifecycle.temp-archives.json` | temp-archives   | Delete archive objects (and abort their multipart uploads) after 1 day.                                                                                                                                                           |
| `setup.sh`                     | one env per run | Creates missing buckets/queues, disables `r2.dev`, applies CORS + lifecycle, prints verification. Idempotent.                                                                                                                     |

The staging app origin is added to `cors.originals.staging.json` once the stable staging alias exists
(T38). CORS is not access control — presigned URLs are — but keeping origins tight limits which
pages can drive uploads with a leaked URL.

## Running setup

```sh
pnpm install
pnpm --filter @lumra/media-gateway exec wrangler login   # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
infra/cloudflare/setup.sh dev          # then staging, production
```

Then, in the dashboard (R2 → Manage R2 API tokens), create `lumra-web-presign-<env>` with
**Object Read & Write** restricted to the `originals` bucket of that environment, and set the
Vercel env vars below. Never reuse production credentials in local or preview environments.

## Web (Vercel) environment variables

| Variable               | Value                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | Cloudflare account ID (forms `https://<id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID`     | Access key of `lumra-web-presign-<env>`                               |
| `R2_SECRET_ACCESS_KEY` | Secret of `lumra-web-presign-<env>` — server-only, never logged       |
| `R2_BUCKET_ORIGINALS`  | `lumra-originals-dev` / `-staging` / `lumra-originals`                |

The web app uses them only through `createR2Client` in `@lumra/media` (S3 API via `aws4fetch`)
to presign single PUTs / multipart parts, create/complete/abort multipart uploads, list parts on
resume and `HEAD` objects at finalization. Presigned URLs work only on the S3 endpoint (not on
custom domains), are bearer credentials until expiry (clamped to 15 min), and must never be
logged. Workers access buckets through bindings and need no R2 keys.

## Verifying privacy (T09 AC)

```sh
# Anonymous access must fail for every bucket (expect 400/401/403, never 200):
curl -sI "https://<account-id>.r2.cloudflarestorage.com/lumra-originals-dev/originals/x/y/z/source"
pnpm --filter @lumra/media-gateway exec wrangler r2 bucket dev-url get lumra-originals-dev  # disabled
```
