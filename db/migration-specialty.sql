-- db/migration-specialty.sql
-- Specialty layer (under council) + position (ตำแหน่ง) ladder.
--
-- Adds a per-council `specialties` table (mirrors `councils`), seeds the 15 Thai
-- Royal Colleges under the Medical Council (TMC), and gives `professionals` a
-- structured `specialty_id` + `position`. CLEs get a denormalized `specialty_id`
-- (copied from the physician at creation, exactly like `council_id`) so the
-- admin/auditor pipeline can be scoped by council AND specialty.
--
-- Idempotent (create-if-not-exists / on-conflict / guarded DO blocks): safe to
-- re-run. Apply via the Supabase SQL editor or `apply_migration` (MCP).
--
-- NOTE: the legacy free-text `professionals.specialty` column is left in place
-- but dormant — `specialty_id` is the new source of truth; display uses the
-- joined specialty name. No hard NOT-NULL/CHECK requiring specialty_id is added:
-- non-medical test councils (PHARM/DENT/ENG) have no seeded specialties, so the
-- requirement is enforced at the API layer (only when the council has any).
-- ===========================================================================


-- ========================= RUN 1 — STRUCTURE ===============================

-- Per-council specialty (e.g. the 15 Royal Colleges under แพทยสภา). Superadmin-seeded
-- CONFIGURATION (like councils — never wiped by reset-demo). One specialty per
-- council-scoped user; the superadmin/analyst/ethics span all (specialty_id = NULL).
create table if not exists public.specialties (
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
create index if not exists specialties_council_idx on public.specialties(council_id);

-- Seed the 15 Royal Colleges (tmc.or.th/RC_committee.php) under the Medical Council.
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

-- Structured specialty + position on every user.
alter table public.professionals
  add column if not exists specialty_id uuid references public.specialties(id);
-- Position ladder (ตำแหน่ง): extern → intern → resident → fellowship → staff → gp (General Practitioner).
alter table public.professionals
  add column if not exists position text
    check (position is null or position in ('extern','intern','resident','fellowship','staff','gp'));
create index if not exists professionals_specialty_idx on public.professionals(specialty_id);

-- Denormalized from the physician's specialty at creation (mirrors cles.council_id;
-- never re-synced on later specialty change) — scopes the admin/auditor pipeline.
alter table public.cles
  add column if not exists specialty_id uuid references public.specialties(id);
create index if not exists cles_council_specialty_idx on public.cles(council_id, specialty_id);

-- Invites carry the invited member's specialty + position (set by the inviter; the invitee
-- inherits them on accept, so no onboarding picker is needed for invited users).
alter table public.invites
  add column if not exists specialty_id uuid references public.specialties(id);
alter table public.invites
  add column if not exists position text
    check (position is null or position in ('extern','intern','resident','fellowship','staff','gp'));

-- Backfill existing TMC council-scoped users that have no specialty yet → Internal Medicine,
-- so specialty scoping doesn't strand them. (Other councils have no seeded specialties.)
update public.professionals p
   set specialty_id = (
     select s.id from public.specialties s
     where s.council_id = p.council_id and s.code = 'IM'
   )
 where p.role in ('admin','physician','auditor')
   and p.specialty_id is null
   and p.council_id = (select id from public.councils where code = 'TMC');


-- ========================= RUN 2 — RLS / POLICIES ==========================
-- Mirrors the councils policies: authenticated read (for the onboarding picker);
-- only superadmin writes. The backend's service-role key bypasses RLS anyway.

alter table public.specialties enable row level security;

drop policy if exists "specialties: authenticated read" on public.specialties;
create policy "specialties: authenticated read"
  on public.specialties for select using (auth.role() = 'authenticated');

drop policy if exists "specialties: superadmin write" on public.specialties;
create policy "specialties: superadmin write"
  on public.specialties for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
