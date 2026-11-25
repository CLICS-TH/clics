-- deploy/vm1/db-move/prepare-plain-pg.sql: make a plain PostgreSQL database ready for GoTrue and the move
-- (#432, ADR 0012). Only for a data host that is NOT the supabase/postgres image (that image has all of
-- this already). Run once, in the target database (CLICS_DATA_DB, e.g. clics_mentor), as its superuser,
-- BEFORE GoTrue starts against it for the first time:
--
--   psql -X -v ON_ERROR_STOP=1 -d clics_mentor -f prepare-plain-pg.sql
--
-- Idempotent: an existing role keeps its password and is only brought to the attributes below. It sets
-- no password: afterwards, at psql's `\password ROLE` prompt, set authenticator's and supabase_auth_admin's
-- (README.md, Plain PostgreSQL target), so none is in a file, an argv or shell history.
--
-- The roles are the ones the supabase/postgres image makes and the restore stream grants to:
--   anon, authenticated   PostgREST's request roles (ADR 0007 grants them nothing in public)
--   service_role          the backend's and RIMPL's request role: bypasses RLS, owns nothing
--   authenticator         PostgREST's login; switches to the three above
--   supabase_auth_admin   GoTrue's login; owns the auth schema, which GoTrue's migrations fill
--   supabase_admin        made with no login if absent: the dump's default privileges name it
--                         (FOR ROLE supabase_admin); an existing one is not changed
-- Roles are cluster-wide: on a cluster that also holds clics_evaluator, they are shared with it.
-- move.sh preflight then checks every role, extension and auth function the restore names.

begin;

-- Roles are cluster-wide. If another database lives in this cluster and one of these roles already exists,
-- it may be another service's login (its PostgREST's authenticator, say): changing it, or `\password` on
-- it, would change that service. Stop unless the operator has confirmed no other service uses these names:
--   PGOPTIONS='-c clics.shared_roles_ok=on' psql ... -f prepare-plain-pg.sql
do $$
declare other text; existing text;
begin
  select string_agg(datname, ', ') into other from pg_catalog.pg_database
   where not datistemplate and datname not in (current_database(), 'postgres');
  select string_agg(rolname, ', ') into existing from pg_catalog.pg_roles
   where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin');
  if other is not null and existing is not null
     and coalesce(current_setting('clics.shared_roles_ok', true), '') <> 'on' then
    raise exception 'this cluster also holds % and the roles % already exist: they may be another service''s logins. Use a cluster of its own, or confirm and set clics.shared_roles_ok=on', other, existing;
  end if;
end $$;

do $$
declare
  r record;
begin
  for r in select * from (values
      ('anon',                'nologin noinherit nobypassrls'),
      ('authenticated',       'nologin noinherit nobypassrls'),
      ('service_role',        'nologin noinherit bypassrls'),
      ('authenticator',       'login noinherit nobypassrls'),
      ('supabase_auth_admin', 'login noinherit createrole nobypassrls')) v(name, attrs)
  loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = r.name) then
      execute format('create role %I', r.name);
    end if;
    -- Never a superuser, a replication role or a database creator, whatever the role had before.
    execute format('alter role %I with nosuperuser nocreatedb noreplication %s', r.name, r.attrs);
  end loop;
  -- supabase_admin only has to exist; one that already does (a superuser someone made) is left alone.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
alter role authenticator set statement_timeout = '8s';
alter role supabase_auth_admin set search_path = auth;
alter role supabase_auth_admin set idle_in_transaction_session_timeout = '60s';

-- GoTrue migrates into the auth schema; it must exist and be supabase_auth_admin's, as in the image.
create schema if not exists auth authorization supabase_auth_admin;
alter schema auth owner to supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

-- Only the CLICS logins may connect: a new database lets every role (PUBLIC) connect, so another
-- service's login on this cluster could otherwise reach it. GoTrue's own set-up gives its admin CREATE.
do $$
begin
  execute format('revoke connect, temporary on database %I from public', current_database());
  execute format('grant connect on database %I to authenticator, supabase_auth_admin', current_database());
  execute format('grant create on database %I to supabase_auth_admin', current_database());
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'clics_analyst') then
    execute format('grant connect on database %I to clics_analyst', current_database());
  end if;
end $$;

-- public: PostgREST's roles may use the schema; the restore brings every table grant (ADR 0007).
grant usage on schema public to anon, authenticated, service_role;

-- PostgREST searches `public, extensions` (PGRST_DB_EXTRA_SEARCH_PATH, ../docker-compose.auth.yml), as on
-- Supabase, and loads no schema cache at all while a schema on that path is missing: every request fails.
-- Here it stays empty; the move creates the extensions the source keeps in public.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- No default privileges here. The move's dump brings production's at its end (service_role gets what postgres
-- creates in public). Set before the restore, they would also hand service_role every table production
-- revoked it from: pg_dump writes no GRANT or REVOKE for a table that has only its owner's grants.

commit;
