-- Corrective migration: align cles FK constraint names with the PLE→CLE rename.
--
-- WHY: migration-cle-rename.sql renamed the table ples→cles and its INDEXES, but Postgres
-- does NOT rename FK CONSTRAINTS on a table rename, so they kept their original ples_* names
-- (the rename migration's own note flags this). `cles` has TWO foreign keys to professionals
-- (physician_id + auditor_id), so a PostgREST embed of professionals is AMBIGUOUS and requires
-- a constraint-name hint. The backend embeds `professionals!cles_physician_id_fkey`
-- (backend/src/routes/admin.js — GET /admin/cles, /admin/cles/flagged, /admin/cles/:id/transcript).
-- Fresh installs (db/schema.sql) auto-name that constraint cles_physician_id_fkey, but the
-- renamed prod DB still had ples_physician_id_fkey, so the hint did not resolve →
-- the CLE list + QA queue returned 500 and the transcript returned a (null-cle) 404. That made
-- the whole admin CLE-management + auditor-assignment surface unusable.
--
-- FIX: rename the constraints to match the code + schema.sql. Metadata-only (no data rewrite),
-- takes a brief lock, and is instantly reversible (rename back). Idempotent — safe to re-run.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'ples_physician_id_fkey' and conrelid = 'public.cles'::regclass) then
    alter table public.cles rename constraint ples_physician_id_fkey to cles_physician_id_fkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'ples_auditor_id_fkey' and conrelid = 'public.cles'::regclass) then
    alter table public.cles rename constraint ples_auditor_id_fkey to cles_auditor_id_fkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'ples_council_id_fkey' and conrelid = 'public.cles'::regclass) then
    alter table public.cles rename constraint ples_council_id_fkey to cles_council_id_fkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'ples_folder_id_fkey' and conrelid = 'public.cles'::regclass) then
    alter table public.cles rename constraint ples_folder_id_fkey to cles_folder_id_fkey;
  end if;
end $$;
