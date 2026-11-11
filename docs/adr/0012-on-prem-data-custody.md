# Data, auth, front ends and AI all run on CME infrastructure; the database moves to a private data host

- **Status:** proposed, 2026-11-10 (jjflow on #404). Becomes accepted when the spec's tickets land.
- **Supersedes in part [ADR 0002](0002-vm1-topology-b.md):** its lines "the database stays in Supabase,
  Tokyo" and "the front ends stay on Vercel", and its R5 reason ("database in Supabase").
- **Amends [ADR 0009](0009-booth-score-from-a-path-score-table.md):** a path score table is built by the
  evaluator locked *at build time*, named in its provenance, not necessarily the evaluator that ships now.

The paper Aj. Somkiat submitted and the statement to the research ethics committee say that participant
data stays on premises and that no commercial AI is used. ADR 0002 moved the application, not the data:
Postgres and sign-in stayed in Supabase (Tokyo), the front ends on Vercel, and every AI purpose still
defaults to Anthropic. We decided to move all of it onto CME infrastructure before participant 1, as
follows:

- **Database:** Postgres (the `supabase/postgres` image, for its roles, `auth` schema and pgvector) runs on
  a **data host** in the CME dev environment, on a private network that only vm1 can reach (Aj. Chanvit's
  option 2 of 2026-11-09). Nothing on it is published to the internet.
- **Sign-in:** self-hosted **GoTrue and PostgREST** run as containers in vm1's `clics` compose project,
  stateless. The CLICS token stays a GoTrue access token, so `verifyJwt`, ADR 0007 and ADR 0008 keep
  their shape. nginx publishes only `/auth/v1` of GoTrue. PostgREST is never published (as RIMPL under R4).
- **Front ends:** move from Vercel to vm1 on one origin, `clics.ccme.or.th`: Portal at `/`, audit-dashboard
  at `/audit`, backend at `/api`, GoTrue at `/auth/v1`. One origin removes CORS and the `?token=` handoff.
- **Email:** Resend stays, for invites (HTTPS API) and as GoTrue's SMTP for OTP and reset mail. It
  receives an address, role, council name and an invite link, never clinical data.
- **AI:** a dormant **local-only mode** (`CLICS_LOCAL_ONLY`) makes RIMPL refuse every non-local provider
  for every purpose, including shadow, embed, chat failover and a cold settings cache. With it on, a
  failed on-prem tutor turn fails closed (turn not charged, text kept), never fails over. The Anthropic key
  stays in the env as the rollback, and the mode is the guard. The mode is switched on once, when the
  readiness checks pass, the decisive evaluator gate passes, a clinician has read a Thai sample, and
  #370's path score tables are built, all before participant 1. If that never happens, the start date
  moves, not the model (roadmap D25).
- **Model identity:** a lock may name the on-prem evaluator by versioned model id plus the server's
  system fingerprint, with `weights_sha256` empty and the Model Lock Record saying so, because CME cannot
  yet give a weights digest. The evaluator prompt label carries the model id, so rows from a different
  model are never pooled into a verdict.
- **Offline authoring** (booth safety review, persona sandbox, path score table builds) may keep using
  Claude. It handles no participant or booth-player data. The PI confirms this reading with the ethics
  committee; this record does not decide it.

## Considered options

- **Database on vm2, on a public network** (Aj. Chanvit's option 1): reachable from the internet, so it
  would need a firewall that admits only vm1 and still leaves a scannable surface.
- **Write our own auth on a `pg` driver:** about 420 supabase-js query sites, 18 RPCs and every sign-in
  path rewritten. That is weeks of work, and a sign-in bug always counts as "cannot wait".
- **Another OIDC server (Keycloak) plus PostgREST:** keeps the data layer and replaces every sign-in path.
- **GoTrue on the data host behind an nginx proxy:** puts internet-originated traffic on the host that is
  meant to have no public path.
- **Logical replication from Supabase:** needs a replication slot in Tokyo and a connection from Tokyo
  into the private network.
- **Keep the old tokens alive across the move** (reuse Supabase's JWT secret): depends on exporting a
  secret Supabase held, and the pilot has not started, so one re-sign-in costs little.
- **Only remove the Anthropic key:** routes still pointed at it fail as retryable 500s, not as a clear
  refusal.

## Consequences

- vm1 now holds GoTrue's JWT secret and the PostgREST role key in memory as well as the backend's. ADR
  0002's residual risks 1 and 2 (the docker group, other teams' runners) cover them, as they already
  covered the service-role key. No PII rests on vm1; R5 holds, now because the data host has the database.
- The database move uses a maintenance window: dump and restore with triggers off (the audit-log hash
  chain re-stamps `created_at` otherwise), per-table checksums, `audit_log_verify`, and sequences carried.
  Everyone signs in once afterwards. The dump streams from vm1 to the data host and never lands on a laptop.
- Backups: an encrypted nightly dump on another CME host, with the key kept off that host, and a tested
  restore. The Supabase project stays read-only as the rollback and is deleted by the owner, with the date
  recorded, before participant 1. Until then, data still sits on commercial cloud, and no CREC-facing text
  may say otherwise.
- `booth_plays` and the open booth dataset move with the database. Their behaviour stays #370's.
- Once local-only mode is on, a CME model outage stops PLE chat. This is the price of the paper's promise.
- The weights of the on-prem evaluator are named, not proven. If CME later supplies a digest, the lock is
  replaced to carry it.
- What CREC-facing text may say once the Supabase project is deleted and local-only mode is on: the data,
  sign-in, front ends and AI run on CME infrastructure in Thailand. The exceptions are Resend for email and
  offline authoring, which the PI confirms.
