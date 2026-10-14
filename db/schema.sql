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

-- Specialty (under council): the 15 Royal Colleges under แพทยสภา, etc. Superadmin-seeded
-- CONFIGURATION (like councils — never wiped). One specialty per council-scoped user;
-- the global roles (superadmin/analyst/ethics) span all (specialty_id = NULL). See
-- db/migration-specialty.sql for the incremental/prod version + the full 15-row seed.
create table public.specialties (
  id         uuid primary key default gen_random_uuid(),
  council_id uuid not null references public.councils(id) on delete cascade,
  code       text not null,                  -- stable machine key, unique within a council
  name_th    text not null,
  name_en    text not null,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz default now(),
  unique (council_id, code)
);
create index specialties_council_idx on public.specialties(council_id);
insert into public.specialties (council_id, code, name_th, name_en, sort)
select c.id, v.code, v.name_th, v.name_en, v.sort
from public.councils c
cross join (values
  ('IM',        'อายุรแพทย์',            'Internal Medicine',        1),
  ('SURG',      'ศัลยแพทย์',             'Surgery',                  2),
  ('OBGYN',     'สูตินรีแพทย์',          'Obstetrics & Gynaecology', 3),
  ('PED',       'กุมารแพทย์',            'Pediatrics',               4),
  ('ORTHO',     'ออร์โธปิดิกส์',          'Orthopaedics',             5),
  ('PSYCH',     'จิตแพทย์',              'Psychiatry',               6),
  ('RADIO',     'รังสีแพทย์',            'Radiology',                7),
  ('ANES',      'วิสัญญีแพทย์',          'Anesthesiology',           8),
  ('PATH',      'พยาธิแพทย์',            'Pathology',                9),
  ('ENT',       'โสต ศอ นาสิกแพทย์',     'Otolaryngology',          10),
  ('OPHTH',     'จักษุแพทย์',            'Ophthalmology',           11),
  ('FAMMED',    'เวชศาสตร์ครอบครัว',     'Family Medicine',         12),
  ('REHAB',     'เวชศาสตร์ฟื้นฟู',       'Rehabilitation Medicine', 13),
  ('NEUROSURG', 'ประสาทศัลยแพทย์',       'Neurological Surgery',    14),
  ('EMERG',     'เวชศาสตร์ฉุกเฉิน',      'Emergency Medicine',      15)
) as v(code, name_th, name_en, sort)
where c.code = 'TMC'
on conflict (council_id, code) do nothing;

-- All users (all 4 roles)
create table public.professionals (
  id             uuid primary key references auth.users(id) on delete cascade,
  -- analyst (Tier-3, aggregate de-identified) + ethics (Tier-4, audit log) are global oversight roles.
  role           text not null check (role in ('superadmin','admin','physician','auditor','analyst','ethics')),
  -- One council per non-superadmin (admin = "director" of this council). Superadmin = NULL.
  council_id     uuid references public.councils(id),
  full_name_th   text not null,
  full_name_en   text not null,
  specialty      text,                              -- legacy free-text (dormant); specialty_id is the source of truth
  specialty_id   uuid references public.specialties(id),  -- structured specialty (under council)
  -- Position ladder (ตำแหน่ง): extern → intern → resident → fellowship → staff → gp (General Practitioner).
  position       text check (position is null or position in ('extern','intern','resident','fellowship','staff','gp')),
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
  -- CLICS §6.4: consecutive Tier-1 fails on natural PLEs; 3 in a row opens Socratic remediation on
  -- the next natural session. Reset to 0 on any Tier-1 pass. See db/migration-ple-episodes.sql.
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
create index professionals_specialty_idx on public.professionals(specialty_id);

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
-- Pilot Test Mode toggle (0/1): when 1, new PLEs are test sessions, the 3-PLE cap is bypassed, and
-- the physician may pick Natural/Socratic directly. See db/migration-pilot-test-mode.sql.
insert into public.app_settings (key, value) values ('pilot_test_mode', 0)
on conflict (key) do nothing;
-- Clinical Artifacts toggle (0/1): when 1, the chat call tells RIMPL it may emit `:::artifact{...}`
-- side-panel blocks (DDx tables, care plans, …). Default 0 — a research-stimulus change, enabled by a
-- superadmin. The transcript strip runs regardless of this flag.
insert into public.app_settings (key, value) values ('clinical_artifacts', 0)
on conflict (key) do nothing;
-- Hold Result Until Audited toggle (0/1): when 1, a physician's PIS-7 score is withheld ("under expert
-- review") until an auditor has scored that PLE — for a blinded test round. Default 0. See
-- db/migration-hold-result-toggle.sql.
insert into public.app_settings (key, value) values ('hold_result_until_audited', 0)
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
  specialty_id    uuid references public.specialties(id),  -- invited member's specialty (council-scoped roles)
  position        text check (position is null or position in ('extern','intern','resident','fellowship','staff','gp')),
  accepted_at     timestamptz,
  email_sent_at   timestamptz,   -- stamped when the accept-link email was delivered (mailer is fail-soft)
  professional_id uuid references public.professionals(id),
  created_at      timestamptz default now()
);
create index invites_email_idx  on public.invites(email);
create index invites_status_idx on public.invites(status);
create unique index invites_one_pending on public.invites(email, role, council_id) where status = 'pending';

-- Physician-created folders for organizing conversations (see db/migration-folders.sql)
create table public.ple_folders (
  id           uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id) on delete cascade,
  name         text not null,
  sort_order   integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index ple_folders_physician_idx on public.ple_folders(physician_id);

-- One row per physician session
create table public.ples (
  id               uuid primary key default gen_random_uuid(),
  physician_id     uuid not null references public.professionals(id),
  auditor_id       uuid references public.professionals(id),
  -- Denormalized from the physician's council at creation time (never re-synced on council change).
  council_id       uuid references public.councils(id),
  -- Denormalized from the physician's specialty at creation (mirrors council_id) — scopes admin/auditor access.
  specialty_id     uuid references public.specialties(id),
  is_test          boolean not null default false,   -- demo/test rows; preserved by reset-demo.js
  folder_id        uuid references public.ple_folders(id) on delete set null,  -- null = Uncategorized
  title            text,                                                       -- physician-editable label
  chief_complaint  text,
  status           text not null default 'active'
                   check (status in ('active','ended','ple_pass','ple_fail_t1','ple_flag_t2','evaluated')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  turn_count       integer default 0,
  token_count      integer default 0,   -- input+output summed; the C3 PLE gate reads this
  input_tokens     bigint  not null default 0,   -- billed input tokens (cost auditability)
  output_tokens    bigint  not null default 0,   -- billed output tokens (cost auditability)
  c1_pass boolean, c2_pass boolean, c3_pass boolean,
  c4_pass boolean, c5_pass boolean, c6_pass boolean,
  -- CLICS protocol §6.4 experimental sequence: episode 1|2|3 (assigned at creation) + Socratic toggle.
  -- CLE2 runs Socratic-from-start ('cle2_examiner'); CLE1/3 are natural unless 3× Tier-1 fails opens
  -- remediation ('t1_remediation'). See db/migration-ple-episodes.sql.
  episode_number   smallint,
  socratic_active  boolean not null default false,
  socratic_reason  text check (socratic_reason is null or socratic_reason in ('cle2_examiner','t1_remediation','pilot_test')),
  ple_code         text unique,   -- PLE-NNN study pseudonym (the only session id in exports); see migration-pseudonym-codes.sql
  provider_used    text default 'claude',   -- reserved for L4 multi-provider rotation (roadmap); currently always 'claude'
  created_at       timestamptz default now()
);
create index ples_folder_idx on public.ples(folder_id);
create index ples_council_idx on public.ples(council_id);
create index ples_council_specialty_idx on public.ples(council_id, specialty_id);

-- Structured patient identifier, PHYSICALLY ISOLATED from `ples` so it never leaks into the
-- cloud-AI payload / auditor blind queue / de-identified export (which all read `ples`). Only the
-- owning physician reads it. See db/migration-patient-intake.sql.
create table public.ple_patient_refs (
  ple_id        uuid primary key references public.ples(id) on delete cascade,
  physician_id  uuid not null references public.professionals(id) on delete cascade,
  patient_ref   text,
  created_at    timestamptz not null default now()
);
create index ple_patient_refs_physician_idx on public.ple_patient_refs(physician_id);
alter table public.ple_patient_refs enable row level security;
drop policy if exists ple_patient_refs_owner on public.ple_patient_refs;
create policy ple_patient_refs_owner on public.ple_patient_refs
  for all using (physician_id = auth.uid()) with check (physician_id = auth.uid());

-- Reversible on-prem PII map (Tier-1 audit): one AES-256-GCM-encrypted token->raw map per PLE so the
-- PI/data custodian can re-identify a [NAME-n]/[HN-n] token. Mirrors oauth_identities: encrypted with
-- IDENTITY_ENC_KEY (backend-only) + RLS DENY-ALL (no policy → service-role only; superadmin reads via
-- the gated, audit-logged endpoint). RIMPL never touches it. See db/migration-pii-map.sql.
create table public.ple_pii_map (
  ple_id        uuid primary key references public.ples(id) on delete cascade,
  map_encrypted text not null,           -- AES-256-GCM(JSON [{token,category,value}]) — never plaintext
  entry_count   int not null default 0,  -- non-PII metadata (number of distinct tokens)
  updated_at    timestamptz not null default now()
);
alter table public.ple_pii_map enable row level security;  -- DENY-ALL (no policy below)

-- One row per chat turn
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  ple_id            uuid not null references public.ples(id) on delete cascade,
  role              text not null check (role in ('physician','assistant')),
  content           text not null,
  refs              jsonb default '[]'::jsonb,
  socratic_question text,
  token_count       integer default 0,
  created_at        timestamptz default now(),
  -- per-turn AI provenance (migration-message-provenance.sql); NULL on physician turns
  provider          text,
  model             text,
  prompt_version    text,
  -- idempotency key of the chat turn (migration-message-client-turn-id.sql); NULL when the client sent none
  client_turn_id    uuid
);
-- one physician row per (PLE, client turn id): a retried turn cannot be stored twice
create unique index messages_ple_client_turn_uidx
  on public.messages (ple_id, client_turn_id)
  where client_turn_id is not null and role = 'physician';

-- A request working on a chat turn RIGHT NOW (migration-message-client-turn-id.sql). Kept out of
-- `messages` so the scored transcript never holds an unanswered keyed row; deny-all to client roles.
create table public.chat_turn_claims (
  ple_id         uuid not null references public.ples(id) on delete cascade,
  client_turn_id uuid not null,
  claim_token    uuid not null,
  status         text not null default 'in_flight' check (status in ('in_flight', 'done')),
  claimed_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (ple_id, client_turn_id)
);
alter table public.chat_turn_claims enable row level security;

-- Store one keyed chat turn (physician + assistant) atomically; refuses a PLE that is no longer active
-- (SQLSTATE CT409). Service role only. (migration-message-client-turn-id.sql)
create or replace function public.store_chat_turn(
  p_ple_id               uuid,
  p_client_turn_id       uuid,      -- NULL for an unkeyed turn: same atomicity and refusal, no idempotency
  p_physician_content    text,
  p_physician_tokens     integer,
  p_assistant_content    text,
  p_refs                 jsonb,
  p_socratic_question    text,
  p_assistant_tokens     integer,
  p_provider             text,
  p_model                text,
  p_prompt_version       text,
  p_replace_physician_id uuid default null)  -- an orphaned question of THIS key to replace (repair)
returns table (physician_id uuid, assistant_id uuid)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_status text;
  v_physician uuid;
  v_assistant uuid;
begin
  -- FOR SHARE: an /end that is closing this session right now commits first, and we then see it closed.
  select status into v_status from public.ples where id = p_ple_id for share;
  if v_status is null then
    raise exception 'store_chat_turn: ple_not_found %', p_ple_id using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'store_chat_turn: ple_not_active % (%)', p_ple_id, v_status using errcode = 'CT409';
  end if;
  -- Repair: remove the orphaned question this turn replaces — only that row (id + PLE + role + key), and
  -- only while no reply carries the key. Inside this transaction, so it is undone if anything below fails
  -- and never happens in a session that has ended (refused above).
  if p_replace_physician_id is not null then
    delete from public.messages m
     where m.id = p_replace_physician_id
       and m.ple_id = p_ple_id
       and m.role = 'physician'
       and m.client_turn_id = p_client_turn_id
       and not exists (select 1 from public.messages a
                        where a.ple_id = p_ple_id and a.role = 'assistant' and a.client_turn_id = p_client_turn_id);
  end if;
  -- Explicit column lists (never an array insert, which sends NULL instead of DEFAULT for an omitted key).
  -- clock_timestamp(), not now(): now() is the transaction start, so both rows would tie on created_at and
  -- the transcript order (ORDER BY created_at) would become arbitrary. A 23505 on the physician key aborts
  -- the whole call, so neither row is stored (and a replaced orphan is restored).
  insert into public.messages (ple_id, role, content, token_count, client_turn_id, created_at)
  values (p_ple_id, 'physician', p_physician_content, coalesce(p_physician_tokens, 0), p_client_turn_id, clock_timestamp())
  returning id into v_physician;
  insert into public.messages (ple_id, role, content, refs, socratic_question, token_count,
                               provider, model, prompt_version, client_turn_id, created_at)
  values (p_ple_id, 'assistant', p_assistant_content, coalesce(p_refs, '[]'::jsonb), p_socratic_question,
          coalesce(p_assistant_tokens, 0), p_provider, p_model, p_prompt_version, p_client_turn_id, clock_timestamp())
  returning id into v_assistant;
  return query select v_physician, v_assistant;
end $$;

revoke all on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid)
  to service_role;

-- PIS-7 scored by AI
create table public.ai_evaluations (
  id               uuid primary key default gen_random_uuid(),
  ple_id           uuid not null references public.ples(id) on delete cascade,
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
  unique (ple_id)   -- one AI evaluation per session; backstops the duplicate-evaluation race
);

-- PIS-7 scored by Expert Auditor
create table public.audit_scores (
  id              uuid primary key default gen_random_uuid(),
  ple_id          uuid not null references public.ples(id) on delete cascade,
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
  unique (ple_id, auditor_id)   -- one score per (session, auditor); backstops the SELECT-then-INSERT race
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

-- Per-PLE score history for LPDP chart
create table public.lpdp_snapshots (
  id              uuid primary key default gen_random_uuid(),
  physician_id    uuid not null references public.professionals(id),
  ple_id          uuid not null references public.ples(id),
  composite_score numeric not null,
  domain_scores   jsonb not null,
  snapshot_at     timestamptz default now(),
  unique (ple_id)   -- one snapshot per session; backstops the duplicate-evaluation race
);

create index audit_scores_council_idx on public.audit_scores(council_id);

-- RLS
alter table public.councils         enable row level security;
alter table public.specialties      enable row level security;
alter table public.council_slots    enable row level security;
alter table public.professionals    enable row level security;
alter table public.ple_folders      enable row level security;
alter table public.ples             enable row level security;
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

-- ple_folders policies
drop policy if exists "folders: physician own" on public.ple_folders;
create policy "folders: physician own"
  on public.ple_folders for all using (physician_id = auth.uid());
drop policy if exists "folders: admin read" on public.ple_folders;
create policy "folders: superadmin read"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "folders: admin read own council"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals me
            join public.professionals owner on owner.id = ple_folders.physician_id
            where me.id = auth.uid() and me.role = 'admin' and me.council_id = owner.council_id)
  );

-- ples policies
create policy "ples: physician own"
  on public.ples for select using (physician_id = auth.uid());
create policy "ples: auditor assigned"
  on public.ples for select using (auditor_id = auth.uid());
create policy "ples: superadmin all"
  on public.ples for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "ples: admin own council"
  on public.ples for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = ples.council_id)
  );
create policy "ples: physician insert"
  on public.ples for insert with check (physician_id = auth.uid());
create policy "ples: physician update own"
  on public.ples for update using (physician_id = auth.uid());

-- messages policies
create policy "msg: physician own ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "msg: auditor assigned ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.auditor_id = auth.uid())
  );
create policy "msg: superadmin all"
  on public.messages for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "msg: admin own council"
  on public.messages for all using (
    exists (select 1 from public.professionals p
            join public.ples pl on pl.id = messages.ple_id
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = pl.council_id)
  );
create policy "msg: physician insert"
  on public.messages for insert with check (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );

-- ai_evaluations policies
create policy "ai_eval: physician own"
  on public.ai_evaluations for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "ai_eval: superadmin all"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "ai_eval: admin own council"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p
            join public.ples pl on pl.id = ai_evaluations.ple_id
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

-- specialties policies (authenticated read for the onboarding picker; only superadmin writes)
create policy "specialties: authenticated read"
  on public.specialties for select using (auth.role() = 'authenticated');
create policy "specialties: superadmin write"
  on public.specialties for all using (
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
    from public.ples where id = new.ple_id;
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
create index if not exists ples_physician_idx                     on public.ples(physician_id);
create index if not exists messages_ple_idx                       on public.messages(ple_id);
create index if not exists ai_evaluations_ple_idx                 on public.ai_evaluations(ple_id);
create index if not exists audit_scores_ple_idx                   on public.audit_scores(ple_id);
create index if not exists audit_scores_auditor_idx               on public.audit_scores(auditor_id);
create index if not exists lpdp_snapshots_physician_idx           on public.lpdp_snapshots(physician_id);
create index if not exists professionals_created_idx              on public.professionals(created_at);
create index if not exists ples_created_idx                       on public.ples(created_at);
-- Hot filters that previously had no index: the auditor queue (auditor_id + status='evaluated'),
-- the reconcile sweep + stats (status), and the LPDP/purge lookups by ple_id.
create index if not exists ples_auditor_idx                       on public.ples(auditor_id);
create index if not exists ples_status_idx                        on public.ples(status);
create index if not exists lpdp_snapshots_ple_idx                 on public.lpdp_snapshots(ple_id);

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

-- CLICS §7.1/§9.2 study pseudonym series: PLE-NNN (sessions) + EXP-NNN (expert auditors).
create sequence if not exists public.ple_code_seq;
create or replace function public.next_ple_code() returns text language sql as $$
  select 'PLE-' || lpad(nextval('public.ple_code_seq')::text, 3, '0');
$$;
create sequence if not exists public.exp_code_seq;
create or replace function public.next_exp_code() returns text language sql as $$
  select 'EXP-' || lpad(nextval('public.exp_code_seq')::text, 3, '0');
$$;

create or replace function public.ple_status_counts(p_council uuid default null, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $$
  select status, count(*)::bigint from public.ples
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
  -- No FK: an `on delete set null` cascade is an UPDATE, which the append-only trigger refuses, and
  -- audit evidence should outlive the user it names (db/migration-audit-log-chain.sql).
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   text,
  council_id  uuid references public.councils(id),
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  -- Hash chain, all three set by the audit_log_chain trigger below — never by the caller.
  seq         bigint not null,
  prev_hash   bytea  not null,
  row_hash    bytea  not null
);
create unique index audit_log_seq_key on public.audit_log(seq);
create index audit_log_created_idx on public.audit_log(created_at);
create index audit_log_target_idx  on public.audit_log(target_type, target_id);
create index audit_log_actor_idx   on public.audit_log(actor_id);
alter table public.audit_log enable row level security;
create policy "audit_log: oversight read" on public.audit_log for select using (
  exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('superadmin','ethics'))
);

-- Hash chain + append-only (see db/migration-audit-log-chain.sql for the reasoning).
-- ---- 3. Canonical form + hash --------------------------------------------------------------------
-- A jsonb array is unambiguous about NULLs and escaping, and jsonb's text output is deterministic
-- (normalised whitespace, sorted object keys). created_at is rendered in UTC with microseconds so the
-- hash does not depend on the session's TimeZone.
create or replace function public.audit_log_row_hash(
  p_prev bytea, p_seq bigint, p_id uuid, p_created_at timestamptz, p_actor_id uuid, p_actor_role text,
  p_action text, p_target_type text, p_target_id text, p_council_id uuid, p_metadata jsonb
) returns bytea
language sql stable
set search_path = pg_catalog
as $$
  select sha256(convert_to(jsonb_build_array(
    encode(p_prev, 'hex'), p_seq, p_id::text,
    to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_actor_id::text, p_actor_role, p_action, p_target_type, p_target_id, p_council_id::text, p_metadata
  )::text, 'UTF8'))
$$;

-- The chain's first prev_hash: 32 zero bytes.
create or replace function public.audit_log_genesis() returns bytea
language sql immutable set search_path = pg_catalog
as $$ select decode(repeat('00', 32), 'hex') $$;

-- ---- 5. Chain on insert --------------------------------------------------------------------------
-- SECURITY DEFINER so the "last row" read never depends on what the INSERTING role can see: a
-- caller whose RLS hid the newest rows would otherwise chain to an older one and fork the chain.
create or replace function public.audit_log_chain() returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_prev bytea;
  v_seq  bigint;
begin
  -- One chain, one writer at a time. Held to the end of the inserting transaction, so the next
  -- writer reads this row's hash only once it is committed (READ COMMITTED takes a new snapshot per
  -- statement). If this transaction rolls back, the next writer simply chains to the real last row.
  perform pg_advisory_xact_lock(7209114052026);
  select a.row_hash, a.seq into v_prev, v_seq from public.audit_log a order by a.seq desc limit 1;
  NEW.seq       := coalesce(v_seq, 0) + 1;
  NEW.prev_hash := coalesce(v_prev, public.audit_log_genesis());
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.row_hash  := public.audit_log_row_hash(NEW.prev_hash, NEW.seq, NEW.id, NEW.created_at, NEW.actor_id,
                     NEW.actor_role, NEW.action, NEW.target_type, NEW.target_id, NEW.council_id, NEW.metadata);
  return NEW;
end $$;

drop trigger if exists audit_log_chain on public.audit_log;
create trigger audit_log_chain before insert on public.audit_log
  for each row execute function public.audit_log_chain();

-- ---- 6. Refuse UPDATE / DELETE / TRUNCATE --------------------------------------------------------
create or replace function public.audit_log_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only (% refused)', tg_op using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

-- ---- 7. Verify + head ----------------------------------------------------------------------------
-- Walks the whole chain. first_bad_seq is null when every row links and hashes correctly; otherwise
-- it is the first seq where a link, a hash or the 1..n numbering breaks.
create or replace function public.audit_log_verify()
returns table (ok boolean, checked bigint, first_bad_seq bigint, reason text, head_seq bigint, head_hash text)
language plpgsql stable
set search_path = public, pg_catalog
as $$
declare
  r record;
  v_prev bytea := public.audit_log_genesis();
  v_expect bigint := 1;
  v_n bigint := 0;
begin
  for r in select * from public.audit_log order by seq loop
    v_n := v_n + 1;
    if r.seq <> v_expect then
      return query select false, v_n, r.seq, 'seq_gap'::text, null::bigint, null::text; return;
    end if;
    if r.prev_hash <> v_prev then
      return query select false, v_n, r.seq, 'prev_hash_mismatch'::text, null::bigint, null::text; return;
    end if;
    if r.row_hash <> public.audit_log_row_hash(r.prev_hash, r.seq, r.id, r.created_at, r.actor_id, r.actor_role,
                                               r.action, r.target_type, r.target_id, r.council_id, r.metadata) then
      return query select false, v_n, r.seq, 'row_hash_mismatch'::text, null::bigint, null::text; return;
    end if;
    v_prev := r.row_hash;
    v_expect := v_expect + 1;
  end loop;
  return query select true, v_n, null::bigint, null::text,
    nullif(v_expect - 1, 0), case when v_n = 0 then null else encode(v_prev, 'hex') end;
end $$;

create or replace function public.audit_log_head()
returns table (head_seq bigint, head_hash text, head_at timestamptz)
language sql stable
set search_path = public, pg_catalog
as $$ select seq, encode(row_hash, 'hex'), created_at from public.audit_log order by seq desc limit 1 $$;

-- Functions are executable by PUBLIC by default, and PostgREST exposes them as RPC to anon and
-- authenticated. Only the service role (the backend) may call these.
revoke all on function public.audit_log_verify() from public, anon, authenticated;
revoke all on function public.audit_log_head()   from public, anon, authenticated;
revoke all on function public.audit_log_row_hash(bytea, bigint, uuid, timestamptz, uuid, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.audit_log_genesis() from public, anon, authenticated;
revoke all on function public.audit_log_chain() from public, anon, authenticated;
grant execute on function public.audit_log_verify()  to service_role;
grant execute on function public.audit_log_head()    to service_role;

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
