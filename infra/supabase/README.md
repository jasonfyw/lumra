# Supabase

Schema, RLS policies and seed data for Lumra (T02). Initialise the local stack with the Supabase CLI:

```sh
supabase init        # once, generates config.toml in this directory
supabase start       # local Postgres, Auth, Inbucket (email) on 5432x ports
supabase db reset    # apply migrations + seed
```

- `migrations/` — versioned SQL, forward-only in production; each PR notes its rollback/forward-fix plan.
- `seed.sql` — synthetic fixtures only.
- `tests/` — RLS/pgTAP tests proving owner isolation and that guest/billing/outbox tables are service-only.
