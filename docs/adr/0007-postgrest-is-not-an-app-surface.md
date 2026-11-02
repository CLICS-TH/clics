# PostgREST is not an app surface

Every CLICS data read and write goes through the backend or RIMPL on the service-role key. The `anon` and `authenticated` roles hold no privilege on any table, sequence or app function in `public`, even though the CLICS token is a Supabase access token and Supabase ships PostgREST open to it. We chose this after #242 found that the default grants let an assigned auditor read a PLE's raw chief complaint, title and conversation, let a physician rewrite their own PLE and insert turns, and let an auditor write scores past the consent and attestation checks. No front-end used any of it: both call only `auth.*`. Closing the whole surface fixes every such hole at once; closing it table by table would leave the next table Supabase's default ACLs grant open. RLS policies stay as a second wall.

## Considered options

- **Revoke only the leaked columns** (`ples.chief_complaint`, `ples.title`, `messages.content`): fixes the read leak in #242 and leaves the write holes.
- **Drop the auditor RLS policies**: the smallest diff, and it leaves every grant and write hole in place.
- **A de-identified view for auditors**: makes PostgREST a second read path that must stay in step with the backend's live RIMPL de-identification. There is no stored de-identified text to put in it.

## Consequences

- A new table, sequence or function in `public` is granted to `anon` and `authenticated` by the default ACLs owned by `supabase_admin`, which the migration role may not be able to change. The hermetic CI test and the `/health/deep` privilege check catch a reopened surface; a migration that adds an object revokes those grants in the same file.
- A future feature that wants direct client reads (Realtime, a client-side query) needs a new ADR, not a grant.
