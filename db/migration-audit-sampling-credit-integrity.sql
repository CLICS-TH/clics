-- Migration: three pilot-readiness features that the manuscript describes and the platform did not
-- yet implement — the minimum-auditor dial, deterministic integrity flags, and the CME credit table.
--
-- All three seed to their SAFE value. Applying this migration changes no behaviour: the auditor
-- target is 1 (today's effective rule), the credit table is OFF, and the flags table starts empty.
--
-- Idempotent. Apply BEFORE deploying the backend that reads these rows.

-- ============================================================================================
-- 1. Minimum auditors per CLE  (WARNS, never BLOCKS)
--
-- The manuscript describes >= 3 blinded auditors per CLE. Staffing does not support that yet: 3
-- auditors cover 3 of 19 physician specialties, and with hold_result_until_audited = 1 a blocking
-- rule would strand credit forever for the other 16. So this is a target the admin queue badges
-- against, not a gate — the score still releases below it, and the ICC report states the rater
-- distribution rather than quietly excluding thin cases.
insert into public.app_settings (key, value) values ('min_auditors_per_cle', 1)
on conflict (key) do nothing;

-- ============================================================================================
-- 2. CME credit conversion  (BUILT, DEFAULT OFF)
--
-- Awarding CME credit is a regulatory act for a licensing body, and the credit gate (ICC >= 0.75)
-- has never been measured against real human auditors. Shipping the capability dormant means
-- switching it on later is a setting change rather than a code change during a frozen pilot;
-- shipping it ON would claim an authority the study has not yet earned.
--
-- Policy lives in DATA so the licensing body can move the bands without a deploy. Four cut points
-- over the 0-100 PIS-7 composite produce five bands; a score exactly ON a cut lands in the HIGHER
-- band. The values below are a starting proposal, not a decision.
insert into public.app_settings (key, value) values
  ('credit_conversion_enabled', 0),   -- 0 = physicians see a PREVIEW and the existing
                                      --     "ยังไม่นับเป็นหน่วยกิต CME" wording is unchanged
  ('credit_base_unit',          1),   -- multiplier applied to every band value
  ('credit_cut_1',             50),
  ('credit_cut_2',             65),
  ('credit_cut_3',             75),
  ('credit_cut_4',             85),
  ('credit_value_1',            0),   -- below threshold
  ('credit_value_2',          0.5),
  ('credit_value_3',            1),
  ('credit_value_4',          1.5),
  ('credit_value_5',            2)
on conflict (key) do nothing;

-- ============================================================================================
-- 3. Deterministic integrity flags
--
-- Signals that a CLE may have been agent-delegated or padded to clear the C1-C3 gate. Computed from
-- data we already store (message content, timestamps, token counts) by backend/src/services/
-- integrity.js -- NOT by a model. An unvalidated model accusing a physician of cheating is a
-- liability, and the same reasoning that puts deterministic C1-C3 before model-scored C4-C6 applies.
--
-- A flag ROUTES a CLE to human review. It never penalises, never reaches the physician, and never
-- changes a score. Several signals fire on legitimate behaviour (pasting a real de-identified case
-- note looks like F3), which is exactly why the output is "a person should look at this".
create table if not exists public.cle_integrity_flags (
  id          uuid primary key default gen_random_uuid(),
  cle_id      uuid not null references public.cles(id) on delete cascade,
  signal      text not null,
  severity    text not null check (severity in ('low','medium','high')),
  evidence    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- One row per (CLE, signal): re-running the detector REPLACES a finding rather than accumulating
  -- a new row every sweep, which would make "how many CLEs are flagged" uncountable.
  unique (cle_id, signal)
);

create index if not exists cle_integrity_flags_cle_idx      on public.cle_integrity_flags(cle_id);
create index if not exists cle_integrity_flags_severity_idx on public.cle_integrity_flags(severity);

comment on table public.cle_integrity_flags is
  'Deterministic gaming/delegation signals per CLE. Routes a session to human review; never a '
  'penalty, never shown to the physician. Written only by the backend service role.';

-- RLS: staff read, nobody writes through the API.
--
-- Physicians must NEVER see these -- a flag is a routing hint for a reviewer, and exposing it would
-- both tip off anyone actually gaming the system and brand honest physicians on a false positive.
-- The backend writes with the service role, which bypasses RLS, so there is deliberately no INSERT
-- or UPDATE policy at all.
alter table public.cle_integrity_flags enable row level security;

drop policy if exists "integrity_flags: staff read" on public.cle_integrity_flags;
create policy "integrity_flags: staff read"
  on public.cle_integrity_flags for select using (
    exists (
      select 1 from public.professionals p
       where p.id = auth.uid()
         and p.role in ('admin','superadmin','auditor','analyst','ethics')
    )
  );
