# Cloudflare

Worker configs live next to their code (`apps/media-gateway/wrangler.jsonc`, `apps/worker/wrangler.jsonc`).
This directory holds account-level resources that are created once per environment (T09).

## Resources per environment (`dev`, `staging`, `production`)

| Resource  | Name pattern                                | Notes                                                                  |
| --------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| R2 bucket | `lumra-originals-<env>`                     | Private. CORS: `PUT` from app origins only. No `r2.dev` access.        |
| R2 bucket | `lumra-derivatives-<env>`                   | Private. Read only through the media gateway.                          |
| R2 bucket | `lumra-temp-archives-<env>`                 | Private. Lifecycle rule: delete after 1 day.                           |
| Queue     | `lumra-jobs-<env>` + `lumra-jobs-dlq-<env>` | Messages carry IDs only.                                               |
| API token | `lumra-web-presign-<env>`                   | Object read/write on `originals` only; used by Vercel to presign PUTs. |
| Route     | `media.<domain>` → `lumra-media-gateway`    | Custom domain for the gateway.                                         |

`cors.originals.json` (to be added in T09) is applied with `wrangler r2 bucket cors set`.
