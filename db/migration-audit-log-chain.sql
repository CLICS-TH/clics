-- db/migration-audit-log-chain.sql
-- Make audit_log tamper-EVIDENT and append-only (CCME architecture proposal R8; CLICS_Proposal §9.4).
--
-- WHY. audit_log was append-only by convention only: the backend writes with the service role, which
-- bypasses RLS, so nothing stopped an UPDATE or DELETE, and the `actor_id ... on delete set null` FK
-- already rewrote rows whenever a user was purged. An ethics committee asking "is this the complete,
-- unaltered record?" could not be given an answer the database itself vouches for.
--
-- WHAT.
--   1. Every row carries seq (contiguous, 1..n), prev_hash and row_hash, where
--        row_hash = sha256( canonical(prev_hash, seq, the row's fields) )
--      so altering, deleting or re-ordering any row breaks every hash after it.
--   2. The chain is computed IN THE DATABASE by a BEFORE INSERT trigger under an advisory lock.
--      It cannot live in Node: 41 of the 42 logEvent() callers are fire-and-forget, so concurrent
--      inserts would race to read "the last hash". seq is assigned inside the lock (last seq + 1),
--      not by a column default — a default is evaluated BEFORE the trigger, so seq order and chain
--      order could disagree.
--   3. UPDATE, DELETE and TRUNCATE are refused by triggers. Triggers fire for the service role too.
--   4. The actor_id FK is dropped (the column stays). Its `on delete set null` is an UPDATE, which the
--      new trigger would refuse — so purging a user would fail. Audit evidence should outlive the user
--      it names; the purge writes its own audit row.
--   5. audit_log_verify() recomputes the chain; audit_log_head() returns the latest (seq, hash) so it
--      can be copied somewhere Supabase cannot rewrite (that copy is what makes a full re-chain
--      detectable — the chain alone proves internal consistency, not that nobody rebuilt it).
--
-- Tamper-EVIDENT, not tamper-PROOF: the table owner can still disable triggers. What it cannot do is
-- change history without verify() reporting it or the externally held head hash disagreeing.
--
-- Uses the built-in sha256(bytea) (PostgreSQL 11+), so no pgcrypto. Idempotent. Apply AFTER the
-- backend code that reads it is deployed (the code tolerates the functions not existing yet).

begin;

-- ---- 1. Columns ----------------------------------------------------------------------------------
alter table public.audit_log add column if not exists seq       bigint;
alter table public.audit_log add column if not exists prev_hash bytea;
alter table public.audit_log add column if not exists row_hash  bytea;

-- ---- 2. Drop the actor_id FK (keep the column) ---------------------------------------------------
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.audit_log'::regclass and con.contype = 'f' and att.attname = 'actor_id'
  loop
    execute format('alter table public.audit_log drop constraint %I', c);
  end loop;
end $$;

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

-- ---- 4. Backfill existing rows in (created_at, id) order — BEFORE the immutability trigger exists --
do $$
declare
  r record;
  v_prev bytea := public.audit_log_genesis();
  v_seq  bigint := 0;
begin
  if exists (select 1 from public.audit_log where seq is null) then
    if exists (select 1 from public.audit_log where seq is not null) then
      raise exception 'audit_log is partially chained; refusing to re-chain';
    end if;
    for r in select * from public.audit_log order by created_at, id loop
      v_seq := v_seq + 1;
      update public.audit_log
         set seq = v_seq, prev_hash = v_prev,
             row_hash = public.audit_log_row_hash(v_prev, v_seq, r.id, r.created_at, r.actor_id, r.actor_role,
                                                  r.action, r.target_type, r.target_id, r.council_id, r.metadata)
       where id = r.id
      returning row_hash into v_prev;
    end loop;
  end if;
end $$;

alter table public.audit_log alter column seq       set not null;
alter table public.audit_log alter column prev_hash set not null;
alter table public.audit_log alter column row_hash  set not null;
create unique index if not exists audit_log_seq_key on public.audit_log(seq);

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

commit;
