-- deploy/vm1/db-move/roles.sql: the data host's roles after the move (#432, ADR 0012, ADR 0007).
--
-- Run on the data host as supabase_admin, after move.sh's verify report passes, and again after any later
-- migration adds a table (the analyst grants are recomputed from the catalog each run). Idempotent:
--
--   psql -X -v ON_ERROR_STOP=1 -f roles.sql
--
-- It sets no password. Passwords go in afterwards, typed at psql's `\password ROLE` prompt, so none is in
-- a file, an argv or shell history (README.md, step 6 of the window).
--
-- 1. The app's roles are the ones the supabase/postgres image already has, and the services log in as:
--      authenticator         PostgREST's login; it switches to service_role for the backend and RIMPL
--      supabase_auth_admin   GoTrue's login (owns the auth schema)
--      service_role          what the backend's requests run as: bypasses RLS, owns nothing
--    None of them, nor anon or authenticated, may be a superuser. The one superuser (supabase_admin, or
--    postgres on plain PostgreSQL) is for the move and this file, and no service's env names it.
-- 2. clics_analyst: read-only rater/analyst access. Not a superuser. It reads the public tables a rating or
--    an analysis needs: scores, timings, codes and pseudonyms. Never the identity tables, never free text
--    (a turn, a title, a note can carry a patient's name), never the auth schema, and it can call no
--    SECURITY DEFINER function (one could write on its behalf).
--    It bypasses RLS: every public table has RLS on with policies keyed on auth.uid(), so without BYPASSRLS
--    it would read nothing. Its column grants, not RLS, are what limit it.
-- 3. clics_backup: the nightly backup's login (backup.sh). Not a superuser, so once the move is over no
--    file on vm1 holds a superuser's password. It reads every row, as a dump must (pg_read_all_data, and
--    BYPASSRLS so RLS never hides a row from it), may call audit_log_head() for the backup's report, and
--    writes nothing.
-- 4. ADR 0007 is untouched: nothing here grants to anon or authenticated, and the last block fails if
--    postgrest_exposure() lists anything.

begin;

-- ---- 1. the app's roles are not superusers ---------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['authenticator', 'supabase_auth_admin', 'service_role', 'anon', 'authenticated'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      raise exception 'role % is missing: on plain PostgreSQL run prepare-plain-pg.sql first', r;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = r and (rolsuper or rolreplication)) then
      raise exception 'role % is a superuser or a replication role; the app must not log in as one', r;
    end if;
  end loop;
  -- Membership would hand a superuser's privileges to an app login through SET ROLE.
  if exists (select 1 from pg_catalog.pg_auth_members m
               join pg_catalog.pg_roles g on g.oid = m.roleid
               join pg_catalog.pg_roles u on u.oid = m.member
              where g.rolsuper and u.rolname in ('authenticator', 'supabase_auth_admin', 'service_role')) then
    raise exception 'an app role is a member of a superuser role';
  end if;
end $$;

-- ---- 2. clics_analyst ------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'clics_analyst') then
    create role clics_analyst;
  end if;
end $$;
alter role clics_analyst with login nosuperuser nocreatedb nocreaterole noreplication bypassrls noinherit
  connection limit 4;
-- A default the session could switch off; the grants below are what refuse a write.
alter role clics_analyst set default_transaction_read_only = on;
alter role clics_analyst set statement_timeout = '5min';
-- A database whose PUBLIC CONNECT was revoked (prepare-plain-pg.sql) needs it granted by name.
do $$ begin execute format('grant connect on database %I to clics_analyst', current_database()); end $$;

revoke all on schema auth from clics_analyst;
grant usage on schema public to clics_analyst;

-- An allow list, not a deny list: CLICS keeps physician text raw on purpose (messages.content, ples.title and
-- chief_complaint, the reflections, the privacy notes, integrity evidence, audit notes and discussions,
-- audit_log.metadata), and a name pattern cannot tell which free text carries a patient's name. So the analyst
-- gets, on every public table except the identity tables below:
--   - every column of a type that cannot hold free text: numbers, booleans, dates and times, intervals, enums,
--     uuids (pg_type categories N, B, D, T, E, and uuid);
--   - and of the text columns, only the codes named in allow_text, which hold a value from a fixed set.
-- Never json/jsonb, arrays, bytea or any other text column. A rater who needs a transcript reads it through
-- the app, behind the privacy gate, not through this role. A new code column is added to allow_text by review.
-- move.sh's verify keeps a copy of both lists below: change it in the same commit (db-move-test.sh compares them).
do $$
declare
  deny_tables text[] := array['access_requests', 'invites', 'oauth_identities', 'license_verifications',
    'identity_verifications', 'ple_pii_map', 'cle_pii_map', 'ple_patient_refs', 'payment_info', 'payouts'];
  allow_text text[] := array['councils.code', 'councils.name_th', 'councils.name_en',
    'specialties.code', 'specialties.name_th', 'specialties.name_en',
    'professionals.role', 'professionals.position', 'professionals.status', 'professionals.pseudonym',
    'professionals.exp_code', 'ples.status',
    'ai_evaluations.model_version', 'ai_evaluations.prompt_version', 'ai_evaluations.rubric_version'];
  t record;
  cols text;
begin
  for t in
    select c.oid, c.relname from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and not exists (select 1 from pg_catalog.pg_depend d
                        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by c.relname
  loop
    -- Start from nothing on every run, so a column whose type or name changed loses its grant.
    execute format('revoke all on table %s from clics_analyst', t.oid::regclass);
    for cols in
      select string_agg(format('%I', a.attname), ', ' order by a.attnum)
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_type ty on ty.oid = a.atttypid
       where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
         and (ty.typcategory in ('N', 'B', 'D', 'T', 'E') or ty.oid = 'pg_catalog.uuid'::regtype
              or (t.relname || '.' || a.attname) = any (allow_text))
    loop
      if t.relname <> all (deny_tables) and cols is not null then
        execute format('grant select (%s) on table %s to clics_analyst', cols, t.oid::regclass);
      end if;
    end loop;
  end loop;
end $$;
revoke all on all sequences in schema public from clics_analyst;

-- ---- 3. clics_backup -------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'clics_backup') then
    create role clics_backup;
  end if;
end $$;
-- INHERIT: its reads come from pg_read_all_data's membership. Three connections: the snapshot session
-- move.sh holds open, and one read at a time beside it.
alter role clics_backup with login nosuperuser nocreatedb nocreaterole noreplication bypassrls inherit
  connection limit 3;
alter role clics_backup set default_transaction_read_only = on;
grant pg_read_all_data to clics_backup;
do $$ begin execute format('grant connect on database %I to clics_backup', current_database()); end $$;
-- The backup's report reads the audit chain's head through this function, which is service_role's only.
do $$
begin
  if pg_catalog.to_regprocedure('public.audit_log_head()') is not null then
    grant execute on function public.audit_log_head() to clics_backup;
  end if;
end $$;
-- pg_read_all_data reads; it never writes. A write grant or a membership given by hand would.
do $$
declare bad text;
begin
  select string_agg(g.rolname, ', ') into bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles g on g.oid = m.roleid
   where m.member = 'clics_backup'::regrole and g.rolname <> 'pg_read_all_data';
  if bad is not null then
    raise exception 'clics_backup is a member of %: it must hold pg_read_all_data only', bad;
  end if;
  -- Through any route (its own grant, PUBLIC's, a membership): has_table_privilege sees them all.
  select string_agg(format('%I.%I', c.relnamespace::regnamespace, c.relname), ', ') into bad
    from pg_catalog.pg_class c
   where c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace) and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and pg_catalog.has_table_privilege('clics_backup', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE');
  if bad is not null then
    raise exception 'clics_backup can write to %: it must only read', bad;
  end if;
end $$;

-- A SECURITY DEFINER function runs as its owner, so one the analyst or the backup could call would write
-- for it. Functions keep PUBLIC's EXECUTE unless a migration revoked it; ADR 0007's migrations revoke it
-- from the app's functions, so this finds none on a schema that passes postgrest_exposure(). The one
-- exception is the backup's audit_log_head(), granted above: it only reads.
do $$
declare
  r text;
  bad text;
begin
  foreach r in array array['clics_analyst', 'clics_backup'] loop
    select string_agg(p.oid::regprocedure::text, ', ') into bad
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and pg_catalog.has_function_privilege(r, p.oid, 'EXECUTE')
       and not (r = 'clics_backup' and p.oid = pg_catalog.to_regprocedure('public.audit_log_head()'))
       and not exists (select 1 from pg_catalog.pg_depend d
                        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
    if bad is not null then
      raise exception '% can execute SECURITY DEFINER functions: % (revoke EXECUTE from PUBLIC on them)', r, bad;
    end if;
  end loop;
end $$;

-- ---- 4. ADR 0007 still holds -----------------------------------------------------------------------------
do $$
declare n bigint;
begin
  if pg_catalog.to_regprocedure('public.postgrest_exposure()') is null then
    raise exception 'public.postgrest_exposure() is missing: the restore did not carry ADR 0007''s schema';
  end if;
  select count(*) into n from public.postgrest_exposure();
  if n > 0 then
    raise exception 'postgrest_exposure() lists % grants to anon/authenticated; ADR 0007 wants none', n;
  end if;
end $$;

commit;
