# Security tests

Automates the PRD §11 abuse matrix (T34). Every state-changing endpoint needs an authorization test here or
next to the handler. Planned suites: guessed R2 keys, expired/forged media tokens, password rotation revocation,
deletion during download, guest claim without capability, concurrent guest reservations, archive path traversal,
Stripe webhook replay, spending-cap enforcement, scraping/rate limits.

Gateway rows (guessed key, expired/forged token, password change, deletion mid-session, expired gallery,
fail-closed access state) are automated next to the handler in `apps/media-gateway/src/gateway.test.ts` (T20).
