# PostgREST is not an app surface

Every CLICS data read and write goes through the backend or RIMPL on the service-role key. The `anon` and `authenticated` roles hold no privilege on any table, sequence or app function in `public`, even though the CLICS token is a Supabase access token and Supabase ships PostgREST open to it. We chose this after #242 found that the default grants let an assigned auditor read a PLE's raw chief complaint, title and conversation, let a physician rewrite their own PLE and insert turns, and let an auditor write scores past the consent and attestation checks. No front-end used any of it: both call only `auth.*`. Closing the whole surface fixes every such hole at once; closing it table by table would leave the next table Supabase's default ACLs grant open. RLS policies stay as a second wall.

## Considered options

- **Revoke only the leaked columns** (`ples.chief_complaint`, `ples.title`, `messages.content`): fixes the read leak in #242 and leaves the write holes.
- **Drop the auditor RLS policies**: the smallest diff, and it leaves every grant and write hole in place.
- **A de-identified view for auditors**: makes PostgREST a second read path that must stay in step with the backend's live RIMPL de-identification. There is no stored de-identified text to put in it.

## Consequences

- `anon` and `authenticated` hold whatever `PUBLIC` holds, so the rule is: revoke from `public, anon, authenticated`, and never grant the client roles.
- A table or sequence that the migration role (`postgres`) creates later arrives closed, because the closure migration changes that role's default privileges. An object that `supabase_admin` creates in `public` may still arrive granted, because `postgres` is expected to be refused when it tries to change `supabase_admin`'s defaults.
- Every new function gets the built-in `PUBLIC` execute, which the closure migration leaves in place because it is a global default. So a migration that creates a function in `public` must revoke `PUBLIC` on it in the same file. Re-running an older migration that re-creates a function reopens it, so re-run the closure migration after it.
- CI checks two things and nothing more:
  - The hermetic Postgres test proves the closure migration itself: the client roles are refused every read, write and function call, and the privilege listing sees a re-grant.
  - A static lint of `db/schema.sql` and `db/migration-*.sql` fails on a grant to `anon`, `authenticated` or `PUBLIC`, and on a function in `public` with no `REVOKE ... FROM PUBLIC` in the same file. Findings that predate the closure sit in a baseline that can only shrink.
  The lint reads SQL text. It does not see dynamic `EXECUTE`, role membership, or anything done in the SQL editor or by `supabase_admin`.
- In production, `/health/deep`'s `postgrest_surface` check reads the effective privileges, counting `PUBLIC`, and reports degraded when the client roles hold any. It is the only guard against drift that CI cannot see.
- A future feature that wants direct client reads (Realtime, a client-side query) needs a new ADR, not a grant.
