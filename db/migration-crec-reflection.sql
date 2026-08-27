-- Migration: post-PLE reflection and the end-of-study acceptability questionnaire
-- (CREC082 ICF §3 steps 3 and 4, Protocol V4.1, SAP secondary outcomes).
--
-- Both were promised to the ethics committee and neither existed: the word "reflection" appeared
-- nowhere in the backend or the portal.
--
-- THE REFLECTION IS SCORED EVIDENCE, NOT A SURVEY. This is the thing that is easy to get wrong.
-- The protocol says PIS-7 is assessed on "หลักฐานที่ปรากฏใน transcript และ reflection ของ PLE", and
-- the D6 anchor begins "0: ไม่มี reflection". So a reflection collected after scoring, or stored
-- somewhere the evaluator never reads, would leave D6 (Reflective Synthesis) — and c6, one of the
-- four qualifying elements — judged on evidence the protocol says is incomplete. It has to be
-- captured BEFORE screening and fed into the transcript the evaluator sees.
--
-- The three prompts are the protocol's own, from PLE Instruction Sheet §3: "จบด้วย reflection ว่า
-- เรียนรู้อะไร ความไม่แน่นอนอะไร และจะตรวจสอบ/นำไปใช้อย่างไร".
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that reads these tables.

create table if not exists public.ple_reflections (
  id            uuid primary key default gen_random_uuid(),
  cle_id        uuid not null unique references public.cles(id) on delete cascade,
  physician_id  uuid not null references public.professionals(id) on delete cascade,

  -- One column per protocol prompt rather than a single free-text blob, so the SAP can report
  -- completeness per prompt and a rater can see which part of the reflection is thin.
  learned       text,   -- เรียนรู้อะไร / what did you learn
  uncertainty   text,   -- ความไม่แน่นอนอะไร / what remains uncertain
  application   text,   -- จะตรวจสอบ/นำไปใช้อย่างไร / how will you verify or apply it

  -- Skipping is explicitly allowed. ICF §7: participation is voluntary and a participant may decline
  -- any part without consequence. A skipped reflection is DATA — it is why D6 scored low — so it is
  -- recorded rather than left as an absent row indistinguishable from "not asked yet".
  skipped       boolean not null default false,
  submitted_at  timestamptz not null default now(),
  created_at    timestamptz default now()
);

create index if not exists ple_reflections_phys_idx on public.ple_reflections (physician_id);

alter table public.ple_reflections enable row level security;
drop policy if exists ple_reflections_no_access on public.ple_reflections;
create policy ple_reflections_no_access on public.ple_reflections for all using (false);

-- The acceptability questionnaire: ONE per physician, after their last PLE.
--
-- "brief acceptability questionnaire หนึ่งครั้งเมื่อสิ้นสุดการเข้าร่วม โดยปกติหลัง PLE ครั้งสุดท้าย
-- (ไม่เกิน 3 ครั้ง). กรณีถอนตัวก่อนครบ 3 PLE participant มีสิทธิไม่ตอบแบบสอบถามโดยไม่มีผลใด."
--
-- Unique on physician_id, not on (physician_id, cle_id): the questionnaire is about the SYSTEM, not
-- about a session. Keying it to a CLE would invite a second response after a fourth session that
-- the protocol does not permit anyway.
create table if not exists public.acceptability_responses (
  id            uuid primary key default gen_random_uuid(),
  physician_id  uuid not null unique references public.professionals(id) on delete cascade,

  -- Likert 1-5 items. The item set is deliberately NOT hardcoded into a constraint beyond the range:
  -- the exact instrument wording is the research team's and the IRB's to set, and this schema should
  -- not be the thing that has to change when they finalise it.
  answers       jsonb not null default '{}'::jsonb,
  -- "ข้อเสนอแนะ" — free-text feedback, a named secondary outcome in the Protocol.
  comments      text,
  skipped       boolean not null default false,
  submitted_at  timestamptz not null default now(),
  created_at    timestamptz default now()
);

alter table public.acceptability_responses enable row level security;
drop policy if exists acceptability_no_access on public.acceptability_responses;
create policy acceptability_no_access on public.acceptability_responses for all using (false);

-- ON by default: the protocol promises the reflection is collected after every PLE, and it is scored
-- evidence. Unlike the identity gate this does not block anyone — a physician may always skip — so
-- defaulting to the protocol's answer costs nothing.
insert into public.app_settings (key, value) values ('reflection_required', 1)
on conflict (key) do nothing;
