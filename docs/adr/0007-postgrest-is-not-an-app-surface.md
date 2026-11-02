# PostgREST is not an app surface

Every CLICS data read and write goes through the backend or RIMPL on the service-role key. The `anon` and `authenticated` roles hold no privilege on any table, sequence or app function in `public`, even though the CLICS token is a Supabase access token and Supabase ships PostgREST open to it. We chose this after #242 found that the default grants let an assigned auditor read a PLE's raw chief complaint, title and conversation, let a physician rewrite their own PLE and insert turns, and let an auditor write scores past the consent and attestation checks. No front-end used any of it: both call only `auth.*`. Closing the whole surface fixes every such hole at once; closing it table by table would leave the next table Supabase's default ACLs grant open. RLS policies stay as a second wall.

## Considered options

- **Revoke only the leaked columns** (`ples.chief_complaint`, `ples.title`, `messages.content`): fixes the read leak in #242 and leaves the write holes.
- **Drop the auditor RLS policies**: the smallest diff, and it leaves every grant and write hole in place.
- **A de-identified view for auditors**: makes PostgREST a second read path that must stay in step with the backend's live RIMPL de-identification. There is no stored de-identified text to put in it.

## Consequences

- `anon` and `authenticated` hold whatever `PUBLIC` holds, so the rule is: revoke from `public, anon, authenticated`, and never grant the client roles.
- A table or sequence that the migration role (`postgres`) creates later arrives closed, because the closure migration changes that role's default privileges. An object that `supabase_admin` creates in `public` may still arrive granted, because `postgres` is expected to be refused when it tries to change `supabase_admin`'s defaults.
- Every new function gets the built-in `PUBLIC` execute. The closure migration leaves that default in place, because it is global. So a migration that creates a function in `public` must revoke `PUBLIC` on that signature in the same file.
  - `create or replace` of an existing function keeps its ACL.
  - A drop and re-create, or a new overload, is a new function and arrives open.
  - Re-running an older migration that does either reopens the surface until the closure migration is re-run after it.
- CI checks two things:
  - **The hermetic Postgres test** proves the closure migration on stand-in tables. The stand-ins carry the real RLS policies on `ples`, `messages` and `audit_scores`. The test checks that `anon`, an assigned auditor and the owning physician are refused reads, writes and app function calls, and that the privilege listing sees a deliberate re-grant.
  - **A static lint** of `db/schema.sql` and `db/migration-*.sql` fails on any of these:
    - a grant to `anon`, `authenticated` or `PUBLIC`, except `USAGE` alone on a schema;
    - default privileges granted to those roles;
    - ownership given to `anon` or `authenticated`;
    - a function in `public` with no `REVOKE ... FROM PUBLIC` on the same signature in the same file.
  - Findings in migrations that predate the closure are listed in a reviewed baseline. A baseline line that no longer matches fails the lint, but nothing stops a new line being added.
  - The lint reads SQL text, so it does not see grants built in dynamic `EXECUTE`, `CREATE AGGREGATE`, `ALTER FUNCTION ... SET SCHEMA public`, SQL outside the top level of `db/`, a `--` inside a string literal, role membership, or anything done in the SQL editor or by `supabase_admin`.
- In production, `/health/deep`'s `postgrest_surface` check lists the tables, views, sequences, columns and functions in `public` on which `anon` or `authenticated` holds an effective privilege, counting `PUBLIC`, and reports degraded when the list is not empty. It does not read schema privileges or default privileges.
- A future feature that wants direct client reads (Realtime, a client-side query) needs a new ADR, not a grant.
