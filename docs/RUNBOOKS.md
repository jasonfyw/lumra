# Runbooks

Filled in as the relevant systems land (T13, T38). Each runbook: symptom → dashboards/queries → mitigation → follow-up.

- [x] [Queue backlog > 30 min / DLQ growth (T12)](#queue-backlog--dead-letter-queue)
- [ ] Upload finalize error rate > 2% (T10)
- [ ] Media gateway 5xx > 1% for 10 min (T20)
- [ ] Stripe webhook unresolved > 15 min (T29)
- [ ] Billed vs provider consumption drift > 10% (T31)
- [ ] Suspected unauthorized disclosure — P1 incident (T34)
- [ ] Database restore from PITR (T37)
- [ ] Disable uploads / checkout via feature flag; read-only mode (T38)

## Queue backlog / dead-letter queue

**Pipeline** (ADR-002): web finalize writes `job_outbox` → worker cron (`* * * * *`, polls ~50 s
per tick) publishes to `lumra-jobs-<env>` → `media.uploaded` consumer → image-processor container
→ derivatives in R2 + `media_variants`. Failed jobs retry with exponential backoff (20 s … 15 min)
and after `max_retries: 5` land in `lumra-jobs-dlq-<env>`. Poison (schema-invalid) messages are
logged as `invalid queue message` and acked, never retried.

**Symptoms**: oldest-message age on `lumra-jobs-*` > 30 min; DLQ message count growing; media stuck
in `uploaded`/`processing`; unprocessed `job_outbox` rows.

**Look first**

1. Worker logs (Workers Observability, `service: "worker"`): `job failed` entries grouped by
   `type`/`error`; `outbox publish failed`; `invalid outbox row`.
2. Processor logs (`service: "image-processor"`): `process failed` with `code`. A burst of
   `processor_unavailable` means the image lost its HEVC decoder (bad deploy; roll back the
   container). `processor_busy` means too few instances: raise `max_instances` /
   `PROCESSOR_POOL_SIZE`.
3. Outbox lag (service role / SQL editor):

   ```sql
   select count(*) as due, min(available_at) as oldest, max(attempt_count) as max_attempts
   from public.job_outbox where processed_at is null and available_at <= now();
   select id, event_name, attempt_count, last_error from public.job_outbox
   where processed_at is null and attempt_count > 0 order by attempt_count desc limit 20;
   ```

4. Stuck media: `select status, count(*) from public.media where status in ('uploaded','processing')
and updated_at < now() - interval '30 minutes' group by 1;` (T13 re-enqueues these).

**Mitigate**

- Transient outage (processor, R2, Postgres): fix the cause, then replay the DLQ. Replays are
  safe: the consumer is idempotent (`ready`/`failed`/deleted media are acked without work).
  ```sh
  # once per environment
  pnpm --filter @lumra/worker exec wrangler queues consumer http add lumra-jobs-dlq-<env>
  # inspect without consuming
  CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
    node apps/worker/scripts/replay-dlq.mjs --from lumra-jobs-dlq-<env> --to lumra-jobs-<env> --dry-run
  # replay (optionally --type media.uploaded --limit 500)
  CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
    node apps/worker/scripts/replay-dlq.mjs --from lumra-jobs-dlq-<env> --to lumra-jobs-<env>
  ```
- Outbox rows failing to publish: `last_error` says why; they retry on their own with backoff
  (capped at 1 h). To force an immediate retry after a fix:
  `update public.job_outbox set available_at = now() where processed_at is null and attempt_count > 0;`
- `invalid outbox payload` rows are producer bugs: fix the writer, then correct or delete the row.
- A single file repeatedly timing out or crashing the processor ends in the DLQ; do not replay it
  blindly. Mark it failed instead:
  `update public.media set status = 'failed', failure_code = 'processing_timeout' where id = '…' and status = 'processing';`

**Follow-up**: record the incident, the replay counts printed by the script, and whether alert
thresholds need tuning.
