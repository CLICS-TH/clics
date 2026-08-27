-- Migration: Socratic rescue bookkeeping (CREC082 PLE Instruction Sheet §4).
--
-- Apply AFTER db/migration-crec-phase0.sql, which opens cles_socratic_reason_chk to accept
-- 'protocol_rescue'. Applying this one first would let the backend write a reason the constraint
-- still rejects — the exact failure mode phase0 exists to clean up.
--
-- The Statistical Analysis Plan commits to reporting, for the rescue: trigger rate, point of
-- activation, exchanges before and after, return-to-PLE-eligibility, and completion time. Those are
-- only answerable if the activation is recorded when it happens; reconstructing "was this turn a
-- rescue?" from message text afterwards is guesswork. Hence four columns, not a boolean.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that writes these columns.

alter table public.cles
  add column if not exists rescue_activated_at timestamptz,
  add column if not exists rescue_reason text,
  add column if not exists rescue_exchanges_before smallint,
  add column if not exists qualified_at timestamptz;

-- Only the two reasons the protocol distinguishes. They are different failures and the SAP reports
-- them separately: an off-topic conversation needs redirecting, a shallow one needs depth.
alter table public.cles drop constraint if exists cles_rescue_reason_chk;
alter table public.cles add constraint cles_rescue_reason_chk
  check (rescue_reason is null or rescue_reason in ('off_topic', 'not_qualifying'));

comment on column public.cles.rescue_activated_at is
  'When Socratic rescue first opened in this session, NULL if it never did. Set once and never '
  'updated — the rescue is a latch, so this is the activation POINT the SAP asks for, not the most '
  'recent occurrence.';

comment on column public.cles.rescue_reason is
  'Why the rescue fired: off_topic (drifted away from clinical learning) or not_qualifying (on '
  'topic but not yet a learning episode by the CREC082 §1 four-element test).';

comment on column public.cles.rescue_exchanges_before is
  'Physician turns completed when the rescue fired. >= 4 by construction (the protocol threshold); '
  'subtract from the final turn_count to get exchanges AFTER, which the SAP also reports.';

comment on column public.cles.qualified_at is
  'When the session first satisfied all four CREC082 §1 elements (c4 meaningful problem, c5 '
  'developing reasoning, c7 context/evidence integration, c6 reflective synthesis). Doubles as the '
  'latch that stops the qualifying classifier re-running on every later turn.';

-- Partial index: the analysis queries all filter to sessions that were actually rescued, which is
-- expected to be a small minority of rows.
create index if not exists cles_rescue_activated_idx
  on public.cles (rescue_activated_at) where rescue_activated_at is not null;

-- ---------------------------------------------------------------------------------------------
-- The PLE qualifying gate: c7, the fourth CREC082 §1 element.
--
-- §1 defines a PLE as a dialogue showing a meaningful problem, developing reasoning, integration of
-- context/evidence, and reflective synthesis. c4, c5 and c6 covered the first, second and fourth.
-- The third had no check at all — a physician could reason and reflect at length without anchoring
-- any of it to guidance, evidence, or the specifics of the case, and the session still passed.
--
-- Nullable and unbackfilled on purpose. NULL means "this session predates the check", which is the
-- truth; defaulting it to false would retroactively fail sessions that were never tested for it, and
-- defaulting to true would assert something nobody measured.
alter table public.cles add column if not exists c7_pass boolean;

comment on column public.cles.c7_pass is
  'CREC082 §1 element 3: the physician connects the discussion to context or evidence rather than '
  'reasoning in the abstract. NULL = session predates the check.';

comment on column public.cles.c1_pass is
  'Effort metadata (>=600s engagement), NOT a gate. Until 2026-08 c1-c3 terminated a session at '
  'cle_fail_t1; CREC082 §1 defines a qualifying PLE by quality (c4-c7), not minutes or tokens, so '
  'these are now recorded and analysed but never decide an outcome.';
