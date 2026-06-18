-- db/schema.sql

create extension if not exists vector;

-- Professional councils (สภาวิชาชีพ): the organizing/scoping dimension. Superadmin-seeded
-- configuration (NOT activity — never wiped by reset-demo). Every physician/auditor/admin
-- belongs to exactly one council; the superadmin spans all (council_id = NULL).
create table public.councils (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,          -- stable machine key: TMC / PHARM / DENT / ENG
  name_th    text not null,
  name_en    text not null,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz default now()
);
insert into public.councils (code, name_th, name_en, sort) values
  ('TMC',   'แพทยสภา',        'Medical Council',     1),
  ('PHARM', 'สภาเภสัชกรรม',   'Pharmacy Council',    2),
  ('DENT',  'ทันตแพทยสภา',     'Dental Council',      3),
  ('ENG',   'สภาวิศวกรรม',     'Engineering Council', 4)
on conflict (code) do nothing;

-- All users (all 4 roles)
create table public.professionals (
  id             uuid primary key references auth.users(id) on delete cascade,
  -- analyst (Tier-3, aggregate de-identified) + ethics (Tier-4, audit log) are global oversight roles.
  role           text not null check (role in ('superadmin','admin','physician','auditor','analyst','ethics')),
  -- One council per non-superadmin (admin = "director" of this council). Superadmin = NULL.
  council_id     uuid references public.councils(id),
  full_name_th   text not null,
  full_name_en   text not null,
  specialty      text,
  license_number text,
  -- License-verification state (see db/migration-license-invites.sql). Auditors require
  -- 'verified'/'manual_verified' to activate; physicians may be active while 'unverified'.
  license_status      text not null default 'unverified'
                      check (license_status in ('unverified','verified','not_found','name_mismatch','manual_verified')),
  license_verified_at timestamptz,
  status         text not null default 'active' check (status in ('active','deactivated')),
  -- "Special" dual role: a physician who may ALSO audit (passes auditor gates; keeps pseudonym;
  -- consumes no auditor slot). Granted via Special invites or admin approval of a role request.
  can_audit      boolean not null default false,
  pseudonym      text unique,   -- P-NNN; the only physician identifier allowed in exports/audit
  exp_code       text unique,   -- EXP-NNN expert-auditor pseudonym (auditors only); see migration-pseudonym-codes.sql
  consented_at   timestamptz,   -- informed consent for the pilot; session creation is gated on this
  -- CLICS §6.4: consecutive Tier-1 fails on natural CLEs; 3 in a row opens Socratic remediation on
  -- the next natural session. Reset to 0 on any Tier-1 pass. See db/migration-cle-episodes.sql.
  consecutive_t1_fails int not null default 0,
  -- Per-physician AI usage meter + per-user limit override (see db/migration-usage-limits.sql).
  usage_cost_usd      numeric not null default 0,
  usage_input_tokens  bigint  not null default 0,
  usage_output_tokens bigint  not null default 0,
  usage_limit_usd     numeric,   -- null => the standard default (app_settings) applies
  created_at     timestamptz default now(),
  -- Everyone except the global oversight roles (superadmin/analyst/ethics) belongs to a council.
  constraint prof_council_required check (role in ('superadmin','analyst','ethics') or council_id is not null),
  -- "Special" (can_audit) may ride ONLY on a physician — DB backstop for normalizeCanAudit so no
  -- code path (provisioning, edit, auditor-request approve) can leave the flag on an admin/auditor.
  constraint can_audit_physician_only check (can_audit = false or role = 'physician')
);
create index professionals_council_idx on public.professionals(council_id);

-- Reusable keyed app settings (e.g. standard_usage_limit_usd). Superadmin-managed.
create table public.app_settings (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz default now()
);
-- Seed the org standard usage limit so a FRESH install matches migrated prod (migration-usage-limits.sql)
-- — otherwise standardLimit() silently falls back to the code default and the superadmin settings read 0.
insert into public.app_settings (key, value) values ('standard_usage_limit_usd', 0.50)
on conflict (key) do nothing;
-- Pilot Test Mode toggle (0/1): when 1, new CLEs are test sessions, the 3-CLE cap is bypassed, and
-- the physician may pick Natural/Socratic directly. See db/migration-pilot-test-mode.sql.
insert into public.app_settings (key, value) values ('pilot_test_mode', 0)
on conflict (key) do nothing;
-- Exactly one superadmin, ever (DB-level guarantee; the API also blocks every 2nd-superadmin path).
create unique index if not exists professionals_single_superadmin
  on public.professionals ((role)) where role = 'superadmin';

-- Editable per-role capacity pool (superadmin-managed). See db/migration-accounts.sql.
-- NOTE: the physician pool is uncapped in code (Google self-signup, ~80K); this row is
-- display-only. admin/auditor capacity is governed PER COUNCIL via council_slots below.
create table public.role_slots (
  role       text primary key check (role in ('superadmin','admin','physician','auditor')),
  capacity   int not null check (capacity >= 0),
  updated_at timestamptz default now()
);
-- Seed defaults so a FRESH install matches migrated prod (migration-accounts.sql) instead of
-- 500-ing PATCH /admin/slots/:role on an empty table.
insert into public.role_slots (role, capacity) values
  ('superadmin', 1), ('admin', 5), ('physician', 100), ('auditor', 20)
on conflict (role) do nothing;

-- Per-council capacity for the small governed pools (admin/auditor). See db/migration-councils.sql.
create table public.council_slots (
  council_id uuid not null references public.councils(id) on delete cascade,
  role       text not null check (role in ('admin','auditor')),
  capacity   int  not null check (capacity >= 0),
  updated_at timestamptz default now(),
  primary key (council_id, role)
);
insert into public.council_slots (council_id, role, capacity)
select c.id, r.role, r.capacity
from public.councils c
cross join (values ('admin', 5), ('auditor', 20)) as r(role, capacity)
on conflict (council_id, role) do nothing;

-- Pending holding area for self-service access requests (email + OAuth).
-- auth_user_id points at a Supabase auth.users row that has NO professionals row yet.
create table public.access_requests (
  id              uuid primary key default gen_random_uuid(),
  email           text,
  full_name_th    text,
  full_name_en    text,
  specialty       text,
  -- 'role_request' = an existing physician asking for auditor rights (the "special" dual role).
  provider        text not null default 'email' check (provider in ('email','google','line','role_request')),
  provider_subject text,
  auth_user_id    uuid,
  council_id      uuid references public.councils(id),  -- council the requester will join
  requested_role  text default 'physician',
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  note            text,
  reviewed_by     uuid references public.professionals(id),
  reviewed_at     timestamptz,
  created_at      timestamptz default now()
);
create index access_requests_status_idx on public.access_requests(status);

-- On-prem ENCRYPTED identity vault (OAuth real identity). Never leaves on-premise,
-- never read by RIMPL. identity_encrypted = AES-256-GCM (key IDENTITY_ENC_KEY).
create table public.oauth_identities (
  id                uuid primary key default gen_random_uuid(),
  professional_id   uuid references public.professionals(id) on delete cascade,
  auth_user_id      uuid,
  provider          text check (provider in ('google','line')),
  provider_subject  text,
  identity_encrypted text not null,
  created_at        timestamptz default now()
);
create index oauth_identities_prof_idx on public.oauth_identities(professional_id);
create unique index oauth_identities_auth_user_uniq on public.oauth_identities(auth_user_id);

-- Audit trail of license-verification attempts (see db/migration-license-invites.sql).
-- evidence_encrypted may carry PII → encrypted at rest + RLS deny-all (service-role only).
create table public.license_verifications (
  id                 uuid primary key default gen_random_uuid(),
  professional_id    uuid references public.professionals(id) on delete set null,
  license_number     text not null,
  name_checked       text,
  status             text not null check (status in ('verified','not_found','name_mismatch','unavailable','manual_verified')),
  source             text not null,        -- 'stub' | 'tmc_scrape' | 'manual'
  evidence_encrypted text,
  checked_at         timestamptz not null default now(),
  created_at         timestamptz default now()
);
create index license_verifications_prof_idx on public.license_verifications(professional_id);
create index license_verifications_lic_idx  on public.license_verifications(license_number);

-- A/B invite links → create a physician/auditor (or superadmin-issued admin) bound to an email.
-- DB stores only sha256(token);
-- the raw token lives only in the accept link. RLS deny-all (service-role only).
create table public.invites (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  email           text not null,
  role            text not null check (role in ('physician','auditor','admin')),
  council_id      uuid not null references public.councils(id),
  created_by      uuid references public.professionals(id),
  status          text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at      timestamptz not null,
  can_audit       boolean not null default false,   -- "Special" invite: physician + auditor rights
  accepted_at     timestamptz,
  email_sent_at   timestamptz,   -- stamped when the accept-link email was delivered (mailer is fail-soft)
  professional_id uuid references public.professionals(id),
  created_at      timestamptz default now()
);
create index invites_email_idx  on public.invites(email);
create index invites_status_idx on public.invites(status);
create unique index invites_one_pending on public.invites(email, role, council_id) where status = 'pending';

-- Physician-created folders for organizing conversations (see db/migration-folders.sql)
create table public.cle_folders (
  id           uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id) on delete cascade,
  name         text not null,
  sort_order   integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index ple_folders_physician_idx on public.cle_folders(physician_id);

-- One row per physician session
create table public.cles (
  id               uuid primary key default gen_random_uuid(),
  physician_id     uuid not null references public.professionals(id),
  auditor_id       uuid references public.professionals(id),
  -- Denormalized from the physician's council at creation time (never re-synced on council change).
  council_id       uuid references public.councils(id),
  is_test          boolean not null default false,   -- demo/test rows; preserved by reset-demo.js
  folder_id        uuid references public.cle_folders(id) on delete set null,  -- null = Uncategorized
  title            text,                                                       -- physician-editable label
  chief_complaint  text,
  status           text not null default 'active'
                   check (status in ('active','ended','cle_pass','cle_fail_t1','cle_flag_t2','evaluated')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  turn_count       integer default 0,
  token_count      integer default 0,   -- input+output summed; the C3 CLE gate reads this
  input_tokens     bigint  not null default 0,   -- billed input tokens (cost auditability)
  output_tokens    bigint  not null default 0,   -- billed output tokens (cost auditability)
  c1_pass boolean, c2_pass boolean, c3_pass boolean,
  c4_pass boolean, c5_pass boolean, c6_pass boolean,
  -- CLICS protocol §6.4 experimental sequence: episode 1|2|3 (assigned at creation) + Socratic toggle.
  -- CLE2 runs Socratic-from-start ('cle2_examiner'); CLE1/3 are natural unless 3× Tier-1 fails opens
  -- remediation ('t1_remediation'). See db/migration-cle-episodes.sql.
  episode_number   smallint,
  socratic_active  boolean not null default false,
  socratic_reason  text check (socratic_reason is null or socratic_reason in ('cle2_examiner','t1_remediation','pilot_test')),
  cle_code         text unique,   -- CLE-NNN study pseudonym (the only session id in exports); see migration-pseudonym-codes.sql
  provider_used    text default 'claude',   -- reserved for L4 multi-provider rotation (roadmap); currently always 'claude'
  created_at       timestamptz default now()
);
create index cles_folder_idx on public.cles(folder_id);
create index cles_council_idx on public.cles(council_id);

-- Structured patient identifier, PHYSICALLY ISOLATED from `cles` so it never leaks into the
-- cloud-AI payload / auditor blind queue / de-identified export (which all read `cles`). Only the
-- owning physician reads it. See db/migration-patient-intake.sql.
create table public.cle_patient_refs (
  cle_id        uuid primary key references public.cles(id) on delete cascade,
  physician_id  uuid not null references public.professionals(id) on delete cascade,
  patient_ref   text,
  created_at    timestamptz not null default now()
);
create index ple_patient_refs_physician_idx on public.cle_patient_refs(physician_id);
alter table public.cle_patient_refs enable row level security;
drop policy if exists ple_patient_refs_owner on public.cle_patient_refs;
create policy ple_patient_refs_owner on public.cle_patient_refs
  for all using (physician_id = auth.uid()) with check (physician_id = auth.uid());

-- Reversible on-prem PII map (Tier-1 audit): one AES-256-GCM-encrypted token->raw map per CLE so the
-- PI/data custodian can re-identify a [NAME-n]/[HN-n] token. Mirrors oauth_identities: encrypted with
-- IDENTITY_ENC_KEY (backend-only) + RLS DENY-ALL (no policy → service-role only; superadmin reads via
-- the gated, audit-logged endpoint). RIMPL never touches it. See db/migration-pii-map.sql.
create table public.cle_pii_map (
  cle_id        uuid primary key references public.cles(id) on delete cascade,
  map_encrypted text not null,           -- AES-256-GCM(JSON [{token,category,value}]) — never plaintext
  entry_count   int not null default 0,  -- non-PII metadata (number of distinct tokens)
  updated_at    timestamptz not null default now()
);
alter table public.cle_pii_map enable row level security;  -- DENY-ALL (no policy below)

-- One row per chat turn
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  cle_id            uuid not null references public.cles(id) on delete cascade,
  role              text not null check (role in ('physician','assistant')),
  content           text not null,
  refs              jsonb default '[]'::jsonb,
  socratic_question text,
  token_count       integer default 0,
  created_at        timestamptz default now()
);

-- PIS-7 scored by AI
create table public.ai_evaluations (
  id               uuid primary key default gen_random_uuid(),
  cle_id           uuid not null references public.cles(id) on delete cascade,
  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score  numeric not null,
  domain_rationale jsonb,
  model_version    text not null default 'CCME_LLM_v8.0',
  prompt_version   text,   -- §10.2 evaluator provenance: hash of the PIS-7 prompt at scoring time
  rubric_version   text,   -- §10.2 evaluator provenance: hash of the PIS-7 weights at scoring time
  evaluated_at     timestamptz default now(),
  unique (cle_id)   -- one AI evaluation per session; backstops the duplicate-evaluation race
);

-- PIS-7 scored by Expert Auditor
create table public.audit_scores (
  id              uuid primary key default gen_random_uuid(),
  cle_id          uuid not null references public.cles(id) on delete cascade,
  auditor_id      uuid not null references public.professionals(id),
  council_id      uuid references public.councils(id),  -- denormalized from the session; kept in sync by audit_scores_guard

  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score numeric not null,
  notes           text,
  scored_at       timestamptz default now(),
  unique (cle_id, auditor_id)   -- one score per (session, auditor); backstops the SELECT-then-INSERT race
);

-- RAG knowledge base (seeded via seed-documents.js)
create table public.documents (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  source    text not null,
  content   text not null,
  embedding vector(1536),
  language  text not null check (language in ('th','en')),
  created_at timestamptz default now()
);

-- Per-CLE score history for LPDP chart
create table public.lpdp_snapshots (
  id              uuid primary key default gen_random_uuid(),
  physician_id    uuid not null references public.professionals(id),
  cle_id          uuid not null references public.cles(id),
  composite_score numeric not null,
  domain_scores   jsonb not null,
  snapshot_at     timestamptz default now(),
  unique (cle_id)   -- one snapshot per session; backstops the duplicate-evaluation race
);

create index audit_scores_council_idx on public.audit_scores(council_id);

-- RLS
alter table public.councils         enable row level security;
alter table public.council_slots    enable row level security;
alter table public.professionals    enable row level security;
alter table public.cle_folders      enable row level security;
alter table public.cles             enable row level security;
alter table public.messages         enable row level security;
alter table public.ai_evaluations   enable row level security;
alter table public.audit_scores     enable row level security;
alter table public.documents        enable row level security;
alter table public.lpdp_snapshots   enable row level security;
alter table public.role_slots       enable row level security;
alter table public.access_requests  enable row level security;
alter table public.oauth_identities enable row level security;  -- DENY-ALL (no policy below)
alter table public.license_verifications enable row level security;  -- DENY-ALL (service-role only)
alter table public.invites               enable row level security;  -- DENY-ALL (service-role only)
alter table public.app_settings     enable row level security;

-- professionals policies
create policy "prof: own read"
  on public.professionals for select using (auth.uid() = id);
create policy "prof: superadmin read all"
  on public.professionals for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "prof: admin read own council"
  on public.professionals for select using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = professionals.council_id)
  );
create policy "prof: superadmin write"
  on public.professionals for insert with check (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- cle_folders policies
drop policy if exists "folders: physician own" on public.cle_folders;
create policy "folders: physician own"
  on public.cle_folders for all using (physician_id = auth.uid());
drop policy if exists "folders: admin read" on public.cle_folders;
create policy "folders: superadmin read"
  on public.cle_folders for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "folders: admin read own council"
  on public.cle_folders for select using (
    exists (select 1 from public.professionals me
            join public.professionals owner on owner.id = cle_folders.physician_id
            where me.id = auth.uid() and me.role = 'admin' and me.council_id = owner.council_id)
  );

-- cles policies
create policy "cles: physician own"
  on public.cles for select using (physician_id = auth.uid());
create policy "cles: auditor assigned"
  on public.cles for select using (auditor_id = auth.uid());
create policy "cles: superadmin all"
  on public.cles for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "cles: admin own council"
  on public.cles for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = cles.council_id)
  );
create policy "cles: physician insert"
  on public.cles for insert with check (physician_id = auth.uid());
create policy "cles: physician update own"
  on public.cles for update using (physician_id = auth.uid());

-- messages policies
create policy "msg: physician own cle"
  on public.messages for select using (
    exists (select 1 from public.cles pl where pl.id = cle_id and pl.physician_id = auth.uid())
  );
create policy "msg: auditor assigned cle"
  on public.messages for select using (
    exists (select 1 from public.cles pl where pl.id = cle_id and pl.auditor_id = auth.uid())
  );
create policy "msg: superadmin all"
  on public.messages for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "msg: admin own council"
  on public.messages for all using (
    exists (select 1 from public.professionals p
            join public.cles pl on pl.id = messages.cle_id
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = pl.council_id)
  );
create policy "msg: physician insert"
  on public.messages for insert with check (
    exists (select 1 from public.cles pl where pl.id = cle_id and pl.physician_id = auth.uid())
  );

-- ai_evaluations policies
create policy "ai_eval: physician own"
  on public.ai_evaluations for select using (
    exists (select 1 from public.cles pl where pl.id = cle_id and pl.physician_id = auth.uid())
  );
create policy "ai_eval: superadmin all"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "ai_eval: admin own council"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p
            join public.cles pl on pl.id = ai_evaluations.cle_id
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = pl.council_id)
  );

-- audit_scores policies
create policy "audit: auditor own"
  on public.audit_scores for all using (auditor_id = auth.uid());
create policy "audit: superadmin all"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "audit: admin own council"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = audit_scores.council_id)
  );

-- documents: any authenticated user can read (for RAG)
create policy "docs: authenticated read"
  on public.documents for select using (auth.role() = 'authenticated');
create policy "docs: superadmin write"
  on public.documents for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- lpdp policies
create policy "lpdp: physician own"
  on public.lpdp_snapshots for select using (physician_id = auth.uid());
create policy "lpdp: superadmin all"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "lpdp: admin own council"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals me
            join public.professionals subj on subj.id = lpdp_snapshots.physician_id
            where me.id = auth.uid() and me.role = 'admin' and me.council_id = subj.council_id)
  );

-- role_slots policies
create policy "slots: admin read"
  on public.role_slots for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "slots: superadmin write"
  on public.role_slots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- access_requests policies (superadmin all; admin only their council's requests)
create policy "requests: superadmin all"
  on public.access_requests for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "requests: admin own council"
  on public.access_requests for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = access_requests.council_id)
  );

-- councils policies (authenticated read for the sign-up picker; only superadmin writes)
create policy "councils: authenticated read"
  on public.councils for select using (auth.role() = 'authenticated');
create policy "councils: superadmin write"
  on public.councils for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- council_slots policies (admins read; only superadmin writes — mirrors role_slots)
create policy "council_slots: admin read"
  on public.council_slots for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "council_slots: superadmin write"
  on public.council_slots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- oauth_identities: DENY-ALL — RLS enabled with NO permissive policy, so only the
-- service-role key (backend) can read/write the on-prem identity vault.

-- app_settings policies (admins read; only superadmin writes — mirrors role_slots)
create policy "app_settings: admin read"
  on public.app_settings for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "app_settings: superadmin write"
  on public.app_settings for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- Backstop: an auditor may never score a session of another council, nor their own
-- session. Enforced even against a direct service-role write (which bypasses RLS).
-- Also keeps audit_scores.council_id in sync with the session.
create or replace function public.audit_scores_guard()
returns trigger language plpgsql as $$
declare
  v_ple_council uuid;
  v_physician   uuid;
  v_aud_council uuid;
begin
  select council_id, physician_id into v_ple_council, v_physician
    from public.cles where id = new.cle_id;
  select council_id into v_aud_council
    from public.professionals where id = new.auditor_id;

  if new.auditor_id = v_physician then
    raise exception 'An auditor cannot score their own session (auditor = physician).';
  end if;
  if v_aud_council is distinct from v_ple_council then
    raise exception 'Cross-council audit is not allowed (auditor council <> session council).';
  end if;
  new.council_id := v_ple_council;
  return new;
end;
$$;

drop trigger if exists audit_scores_guard_trg on public.audit_scores;
create trigger audit_scores_guard_trg
  before insert on public.audit_scores
  for each row execute function public.audit_scores_guard();

-- License No. / TMC verification RETIRED (2026-06-09): onboarding is Google self-service +
-- A/B invite links, and an A/B invite alone activates an auditor. The license_* columns +
-- license_verifications table are kept DORMANT (nullable, unwritten) for reversibility; the
-- enforcing trigger is intentionally NOT created. See db/migration-drop-license-gate.sql.

-- Atomic increment of a physician's running usage meter (see db/migration-usage-limits.sql).
create or replace function public.increment_usage(
  p_id uuid, p_cost numeric, p_in bigint, p_out bigint
) returns void
language sql as $$
  update public.professionals
     set usage_cost_usd      = usage_cost_usd      + p_cost,
         usage_input_tokens  = usage_input_tokens  + p_in,
         usage_output_tokens = usage_output_tokens + p_out
   where id = p_id;
$$;

-- pgvector similarity search function
create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.75,
  match_count     int   default 3
)
returns table (id uuid, title text, source text, content text, similarity float)
language sql stable as $$
  select
    d.id, d.title, d.source, d.content,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- ===== Scale (see db/migration-scale.sql) — indexes, O(1) pseudonyms, SQL aggregates =====
create index if not exists professionals_role_status_idx          on public.professionals(role, status);
create index if not exists professionals_council_role_status_idx  on public.professionals(council_id, role, status);
create index if not exists professionals_pseudonym_idx            on public.professionals(pseudonym);
create index if not exists cles_physician_idx                     on public.cles(physician_id);
create index if not exists messages_ple_idx                       on public.messages(cle_id);
create index if not exists ai_evaluations_ple_idx                 on public.ai_evaluations(cle_id);
create index if not exists audit_scores_ple_idx                   on public.audit_scores(cle_id);
create index if not exists audit_scores_auditor_idx               on public.audit_scores(auditor_id);
create index if not exists lpdp_snapshots_physician_idx           on public.lpdp_snapshots(physician_id);
create index if not exists professionals_created_idx              on public.professionals(created_at);
create index if not exists cles_created_idx                       on public.cles(created_at);
-- Hot filters that previously had no index: the auditor queue (auditor_id + status='evaluated'),
-- the reconcile sweep + stats (status), and the LPDP/purge lookups by cle_id.
create index if not exists cles_auditor_idx                       on public.cles(auditor_id);
create index if not exists cles_status_idx                        on public.cles(status);
create index if not exists lpdp_snapshots_ple_idx                 on public.lpdp_snapshots(cle_id);

create sequence if not exists public.pseudonym_seq;
select setval('public.pseudonym_seq',
  greatest(1, coalesce((select max((substring(pseudonym from 3))::int) from public.professionals where pseudonym ~ '^P-[0-9]+$'), 0) + 1),
  false);

create or replace function public.next_pseudonym() returns text language sql as $$
  select 'P-' || lpad(nextval('public.pseudonym_seq')::text, 3, '0');
$$;

-- CLICS §6.4 Tier-1 remediation counter: reset on a Tier-1 pass, increment on fail.
create or replace function public.record_t1_outcome(p_id uuid, p_pass boolean) returns void
language sql as $$
  update public.professionals
     set consecutive_t1_fails = case when p_pass then 0 else consecutive_t1_fails + 1 end
   where id = p_id;
$$;

-- CLICS §7.1/§9.2 study pseudonym series: CLE-NNN (sessions) + EXP-NNN (expert auditors).
create sequence if not exists public.cle_code_seq;
create or replace function public.next_cle_code() returns text language sql as $$
  select 'CLE-' || lpad(nextval('public.cle_code_seq')::text, 3, '0');
$$;
create sequence if not exists public.exp_code_seq;
create or replace function public.next_exp_code() returns text language sql as $$
  select 'EXP-' || lpad(nextval('public.exp_code_seq')::text, 3, '0');
$$;

create or replace function public.cle_status_counts(p_council uuid default null, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $$
  select status, count(*)::bigint from public.cles
  where (p_council is null or council_id = p_council) and (p_include_test or is_test = false)
  group by status;
$$;

create or replace function public.total_usage_sum() returns numeric language sql stable as $$
  select coalesce(sum(usage_cost_usd), 0) from public.professionals;
$$;

-- Active members grouped by council × role (superadmin executive overview).
create or replace function public.council_member_counts()
returns table(council_id uuid, role text, n bigint) language sql stable as $$
  select council_id, role, count(*)::bigint
  from public.professionals
  where status = 'active' and council_id is not null
  group by council_id, role;
$$;

-- ===== Audit trail (see db/migration-audit-log.sql) — append-only event log for the ethics committee =====
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.professionals(id) on delete set null,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   text,
  council_id  uuid references public.councils(id),
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log(created_at);
create index audit_log_target_idx  on public.audit_log(target_type, target_id);
create index audit_log_actor_idx   on public.audit_log(actor_id);
alter table public.audit_log enable row level security;
create policy "audit_log: oversight read" on public.audit_log for select using (
  exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('superadmin','ethics'))
);

-- ===== Structured informed consent (see db/migration-consents.sql) — auditable consent records =====
create table public.consents (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  role_context    text not null check (role_context in ('physician','auditor')),
  consent_version text not null,
  checkboxes      jsonb not null default '{}'::jsonb,
  coi             jsonb,
  agreed_at       timestamptz not null default now(),
  unique (professional_id, role_context, consent_version)
);
create index consents_prof_idx on public.consents(professional_id);
alter table public.consents enable row level security;
create policy "consents: own" on public.consents for all
  using (professional_id = auth.uid()) with check (professional_id = auth.uid());
create policy "consents: oversight read" on public.consents for select using (
  exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('superadmin','ethics'))
);
