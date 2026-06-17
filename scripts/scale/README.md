# CLICS scale harness

Validate ~80K-user DB scale against a **throwaway TEST Supabase** (never the live pilot DB).
Confirms `db/migration-scale.sql` does its job: index-backed hot paths and an O(1) pseudonym
allocator instead of the old full-table scan.

These follow the `scripts/soak/*` convention — run from `backend/` so `@supabase/supabase-js`
resolves via `NODE_PATH`, and read the Supabase creds from the environment.

## Prerequisites

1. A **test** Supabase project (not prod). Apply the schema + the scale migration to it:
   - `db/schema.sql` (or at minimum the `councils`, `professionals`, `cles` tables), then
   - `db/migration-scale.sql` — indexes, the `next_pseudonym()` sequence, and aggregate RPCs.
2. Export the test creds (service-role key — admin API + bypasses RLS):

   ```bash
   export SUPABASE_URL="https://<your-test-ref>.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="<test service_role key>"
   ```

## Run

```bash
cd backend

# 1) Seed ~80K synthetic physicians (default COUNT=80000; override with COUNT=...).
NODE_PATH="$PWD/node_modules" node ../scripts/scale/seed-80k.js
# e.g. a quick 5K smoke run:
COUNT=5000 NODE_PATH="$PWD/node_modules" node ../scripts/scale/seed-80k.js

# 2) Benchmark the hot paths (prints a min/median/max ms table).
NODE_PATH="$PWD/node_modules" node ../scripts/scale/bench.js
RUNS=15 NODE_PATH="$PWD/node_modules" node ../scripts/scale/bench.js
```

`seed-80k.js` is idempotent-ish: it counts existing synthetic physicians (`role=physician`,
`pseudonym LIKE 'P-%'`) and seeds only the remaining `P-<n>` indices, so a re-run resumes rather
than duplicating. It prints per-chunk progress (~rate/s) and total time.

### FK note (why auth users are created)

`public.professionals.id REFERENCES auth.users(id) ON DELETE CASCADE`. You cannot insert a
`professionals` row without a matching `auth.users` row. `seed-80k.js` takes **approach (a)**: it
creates one confirmed lightweight auth user per physician (`supabase.auth.admin.createUser`,
bounded concurrency), then bulk-inserts the `professionals` rows in batches of 1000 via
`supabase.from('professionals').insert([...])`. GoTrue's `createUser` is the throughput bottleneck,
not the table insert. (Approach (b) — writing `auth.users` directly — would need raw SQL/admin DB
access the JS service-role client doesn't expose and would skip GoTrue bookkeeping, so it's not used.)

Synthetic rows: `role='physician'`, `status='active'`, council `TMC`, `license_status='unverified'`,
unique `pseudonym=P-<i>`, synthetic `full_name_th/en`, emails `scale-p<i>@scale.test`.

## What `bench.js` measures

| # | Path | Backend analogue |
|---|------|------------------|
| 1a | `next_pseudonym()` RPC (O(1) sequence) | `nextPseudonym()` on every physician signup |
| 1b | legacy full-scan (select all pseudonyms → JS max) | pre-migration `nextPseudonym()` fallback |
| 2 | `count(role=physician, status=active)` | slot `usedCount` check |
| 3 | `professionals` page, `limit 50` | admin roster list |
| 4 | `cles` page, `limit 50` order by `started_at` | admin sessions list |

Each is wall-clock timed `RUNS` times (default 10, one warm-up discarded); the table reports
min / median / max ms and flags `OK <100ms`. The headline line shows the legacy-vs-RPC speedup.

### Confirming index usage (query planner)

The JS service-role client cannot run arbitrary SQL, so `bench.js` times round-trips rather than
reading `EXPLAIN ANALYZE` plans. To prove the planner uses the new indexes (Index Scan, not
Seq Scan), run these in the **Supabase SQL editor** against the seeded test DB:

```sql
-- slot count — expect an index-only/bitmap scan on professionals_role_status_idx
explain analyze
select count(*) from public.professionals where role = 'physician' and status = 'active';

-- professionals page
explain analyze
select id, pseudonym, full_name_en, role, status, council_id
from public.professionals where role = 'physician'
order by created_at desc limit 50;

-- cles page
explain analyze
select id, physician_id, status, started_at, turn_count, token_count
from public.cles order by started_at desc limit 50;

-- pseudonym allocation: O(1) sequence (no table scan at all)
explain analyze select public.next_pseudonym();
```

## Cleanup

These scripts create tens of thousands of auth users + professionals rows in the **test** project.
To wipe them afterwards, run in the Supabase SQL editor (this is a TEST DB — destructive):

```sql
-- Deleting the auth users cascades to professionals (FK ON DELETE CASCADE).
delete from auth.users
where email like 'scale-p%@scale.test';
```

If you also want to reset the pseudonym sequence back to the live max+1 afterwards, re-run the
`setval(...)` block at the top of `db/migration-scale.sql`.

> The throwaway password in `seed-80k.js` (`ScaleTest#2026`) is for unused test accounts only — no
> live credential or API key appears in this directory. Never point these scripts at the live DB.
