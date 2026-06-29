-- Migration: SANDBOX council + 5 sandbox specialties (isolated test cohort)
--
-- Creates a dedicated SANDBOX council (separate from the 4 real councils + 15 real specialties) with
-- 5 sandbox specialties, for a mobile test of the blind audit pipeline. Council isolation keeps the
-- test cohort fully separate from real data. Groups 1–3 use specialties SBX-1..SBX-3 (each group =
-- 1 admin + 1 auditor + 2 physicians); SBX-4/SBX-5 are spares.
--
-- Idempotent (on-conflict guards). Apply via the Supabase SQL editor or `apply_migration` (MCP).
-- ===========================================================================

-- 1. Sandbox council (sort 99 so it lists last; clearly labelled "ทดสอบ").
insert into public.councils (code, name_th, name_en, sort) values
  ('SANDBOX', 'สภาทดสอบ (Sandbox)', 'Sandbox Council', 99)
on conflict (code) do nothing;

-- 2. Five sandbox specialties under SANDBOX (mirrors the migration-specialty.sql seed pattern).
insert into public.specialties (council_id, code, name_th, name_en, sort)
select c.id, v.code, v.name_th, v.name_en, v.sort
from public.councils c
cross join (values
  ('SBX-1', 'สาขาทดสอบ 1', 'Sandbox Specialty 1', 1),
  ('SBX-2', 'สาขาทดสอบ 2', 'Sandbox Specialty 2', 2),
  ('SBX-3', 'สาขาทดสอบ 3', 'Sandbox Specialty 3', 3),
  ('SBX-4', 'สาขาทดสอบ 4', 'Sandbox Specialty 4', 4),
  ('SBX-5', 'สาขาทดสอบ 5', 'Sandbox Specialty 5', 5)
) as v(code, name_th, name_en, sort)
where c.code = 'SANDBOX'
on conflict (council_id, code) do nothing;

-- 3. Slot capacity for the SANDBOX council so the test admins + auditors can be created (a brand-new
--    council otherwise defaults to no slots → POST /admin/users 409s). Admin/auditor are per-council;
--    physicians are uncapped. 5 each comfortably covers 3 group admins + 3 group auditors.
insert into public.council_slots (council_id, role, capacity)
select c.id, v.role, v.capacity
from public.councils c
cross join (values ('admin', 5), ('auditor', 5)) as v(role, capacity)
where c.code = 'SANDBOX'
on conflict (council_id, role) do nothing;
