-- db/migration-postgrest-closed.sql
-- Close the PostgREST data surface (#281, spec #279, ADR 0007 "PostgREST is not an app surface").
--
-- WHY. The portal ships the anon key and every signed-in user holds a Supabase session token (the CLICS token).
-- With Supabase's default grants, those two reach every table in `public` through PostgREST, and RLS is the
-- only filter left. RLS does not hide columns: an assigned auditor's policy let them read ples.chief_complaint
-- and messages.content directly, bypassing the de-identified view the backend serves (#242). The backend and
-- RIMPL use the service-role key for all data and no front-end reads PostgREST data, so the client roles need
-- no privilege at all.
--
-- WHAT.
--   1. Revokes every privilege on every table, view and sequence in `public` from public, anon and
--      authenticated. A table-level revoke also drops the column grants on messages
--      (db/migration-message-provenance.sql).
--   2. Revokes EXECUTE on every function in `public` that is not an extension member from public, anon and
--      authenticated, and grants it to service_role. PUBLIC must go too: anon executes through it otherwise.
--      Extension functions (pgvector) are left as their extension made them.
--   3. Changes the default privileges of the role applying this, so tables and sequences it creates later
--      arrive closed. A new function still gets the built-in PUBLIC execute, which is a global default; its own
--      migration revokes it, and postgrest_exposure() lists it until then.
--      It then tries the same for supabase_admin. On Supabase, `postgres` is expected to be REFUSED for
--      supabase_admin's defaults (it is not a member of that role), so an object supabase_admin creates in
--      `public` can still arrive granted to anon/authenticated. /health/deep's postgrest_surface check is the
--      guard for that drift: it reads public.postgrest_exposure() and degrades when the list is not empty.
--   4. Enables RLS on ple_code_migration (created without it by db/migration-ple-rename.sql), when present.
--   5. Creates public.postgrest_exposure(): every object in `public` where anon or authenticated holds an
--      effective privilege (a PUBLIC grant counts), including column grants and MAINTAIN on PG 17+. Catalogs only, never table rows.
--      Only service_role may execute it.
--   No RLS policy is dropped or changed, and USAGE on schema public is untouched.
--
-- ORDER. Deploy the backend first: until this is applied its health check reads `not_installed`, which does not
-- degrade. The owner applies this, on scaletest first, then prod; /health/deep then reads `closed`.
-- Safe to re-run (idempotent). Tested against a throwaway PostgreSQL by scripts/db/postgrest-surface-test.sh.
-- ===========================================================================

begin;

-- PUBLIC too: anon and authenticated hold whatever PUBLIC holds. service_role keeps its own explicit grants.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', f);
    execute format('grant execute on routine %s to service_role', f);
  end loop;
end $$;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- The built-in PUBLIC execute on new functions is a global default. It stays: changing it would reach every
-- schema this role writes. A new function in public must revoke PUBLIC itself, and postgrest_exposure() lists
-- it until then. Most earlier migrations do not, so re-running one that re-creates a function re-opens it: re-run
-- this file after it.

do $$
begin
  alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated;
  alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated;
  alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated;
exception
  when insufficient_privilege then
    raise notice 'supabase_admin default privileges unchanged (insufficient privilege); /health/deep postgrest_surface guards objects it creates';
  when undefined_object then
    raise notice 'supabase_admin does not exist; its default privileges were not changed';
end $$;

do $$
begin
  if to_regclass('public.ple_code_migration') is not null then
    alter table public.ple_code_migration enable row level security;
  end if;
end $$;

create or replace function public.postgrest_exposure()
returns table(object_name text, object_kind text, grantee text, privilege text)
language sql
stable
security invoker
set search_path = ''
as $$
  with roles(grantee) as (values ('anon'::text), ('authenticated'::text)),
  rels as (
    select c.oid, c.relname::text as name, c.relkind
    from pg_catalog.pg_class c
    where c.relnamespace = 'public'::pg_catalog.regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = c.oid and d.deptype = 'e')
  )
  select r.name, case when r.relkind in ('v', 'm') then 'view' else 'table' end, g.grantee, p.priv
  from rels r
  cross join roles g
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || case when pg_catalog.current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else '{}'::text[] end) p(priv)
  where r.relkind <> 'S' and pg_catalog.has_table_privilege(g.grantee, r.oid, p.priv)
  union all
  select r.name, 'sequence', g.grantee, p.priv
  from rels r
  cross join roles g
  cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) p(priv)
  where r.relkind = 'S' and pg_catalog.has_sequence_privilege(g.grantee, r.oid, p.priv)
  union all
  select r.name || '.' || a.attname::text, 'column', g.grantee, p.priv
  from rels r
  join pg_catalog.pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  cross join roles g
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
  where r.relkind <> 'S'
    and pg_catalog.has_column_privilege(g.grantee, r.oid, a.attnum, p.priv)
    and not pg_catalog.has_table_privilege(g.grantee, r.oid, p.priv)
  union all
  select f.proname::text || '(' || pg_catalog.pg_get_function_identity_arguments(f.oid) || ')', 'function', g.grantee, 'EXECUTE'
  from pg_catalog.pg_proc f
  cross join roles g
  where f.pronamespace = 'public'::pg_catalog.regnamespace
    and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = f.oid and d.deptype = 'e')
    and pg_catalog.has_function_privilege(g.grantee, f.oid, 'EXECUTE')
  order by 1, 2, 3, 4
$$;

revoke all on function public.postgrest_exposure() from public, anon, authenticated;
grant execute on function public.postgrest_exposure() to service_role;

comment on function public.postgrest_exposure() is
  'Every object in public where anon or authenticated holds an effective privilege (#281, ADR 0007). Catalogs '
  'only. Empty means the PostgREST data surface is closed; /health/deep reports it as postgrest_surface.';

commit;
