-- db/migration-councils.sql
-- Multi-council update: professional councils (สภาวิชาชีพ) as the organizing/scoping
-- dimension, denormalized council_id onto sessions for 80K-scale filtering, a keep-test
-- flag, and per-council admin/auditor capacity pools.
--
-- IMPORTANT: run this in the Supabase SQL editor as TWO separate queries.
-- The editor wraps a multi-statement script in ONE transaction, so a single
-- policy error rolls the whole thing back. Run "STRUCTURE" first, verify it
-- succeeded (esp. the zero-null checks), then run "RLS / POLICIES".
-- ===========================================================================


-- ========================= RUN 1 — STRUCTURE ===============================

-- Professional councils (สภาวิชาชีพ). Superadmin-seeded configuration, NOT activity.
-- Every physician + auditor + admin belongs to exactly one council; the superadmin
-- spans all councils (council_id = NULL).
create table if not exists public.councils (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,          -- stable machine key: TMC / PHARM / DENT / ENG
  name_th    text not null,
  name_en    text not null,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz default now()
);

-- Seed the four pilot councils (Medical first so it is the backfill default).
insert into public.councils (code, name_th, name_en, sort) values
  ('TMC',   'แพทยสภา',        'Medical Council',     1),
  ('PHARM', 'สภาเภสัชกรรม',   'Pharmacy Council',    2),
  ('DENT',  'ทันตแพทยสภา',     'Dental Council',      3),
  ('ENG',   'สภาวิศวกรรม',     'Engineering Council', 4)
on conflict (code) do nothing;

-- council_id on people. Nullable at the column level (superadmin = NULL); the
-- "everyone else has one" invariant is a CHECK added AFTER backfill (see below).
alter table public.professionals
  add column if not exists council_id uuid references public.councils(id);

-- Denormalized council_id on sessions + audit rows so admin route filters, the
-- council-scoped RLS predicates, and per-council ICC never need a professionals
-- join at 80K-physician scale. Set at WRITE time; never updated if a user later
-- changes council (historical sessions keep their original council).
alter table public.ples
  add column if not exists council_id uuid references public.councils(id);
alter table public.ples
  add column if not exists is_test boolean not null default false;  -- demo/test rows preserved by reset-demo
alter table public.audit_scores
  add column if not exists council_id uuid references public.councils(id);

-- Council carried on an access request so auditor elevation stays within one council.
alter table public.access_requests
  add column if not exists council_id uuid references public.councils(id);

-- Per-council capacity for the small governed pools (admin/auditor). The physician
-- pool is uncapped in code (Google self-signup, ~80K) and stays in the global
-- role_slots table for display only.
create table if not exists public.council_slots (
  council_id uuid not null references public.councils(id) on delete cascade,
  role       text not null check (role in ('admin','auditor')),
  capacity   int  not null check (capacity >= 0),
  updated_at timestamptz default now(),
  primary key (council_id, role)
);

-- Seed default admin/auditor capacity for every existing council.
insert into public.council_slots (council_id, role, capacity)
select c.id, r.role, r.capacity
from public.councils c
cross join (values ('admin', 5), ('auditor', 20)) as r(role, capacity)
on conflict (council_id, role) do nothing;

-- ---- Backfill (order matters: people → sessions → audit rows) --------------
-- Every non-superadmin gets the Medical Council; superadmin stays NULL.
update public.professionals
   set council_id = (select id from public.councils where code = 'TMC')
 where role <> 'superadmin' and council_id is null;

-- Sessions inherit their physician's council.
update public.ples pl
   set council_id = pr.council_id
  from public.professionals pr
 where pr.id = pl.physician_id and pl.council_id is null;

-- Audit rows inherit their session's council.
update public.audit_scores a
   set council_id = pl.council_id
  from public.ples pl
 where pl.id = a.ple_id and a.council_id is null;

-- ---- Verify zero nulls BEFORE adding the check (run these SELECTs; expect 0) --
-- select count(*) from public.professionals where role <> 'superadmin' and council_id is null;
-- select count(*) from public.ples         where council_id is null;
-- select count(*) from public.audit_scores where council_id is null;

-- Now enforce "every non-superadmin has a council" and index the hot filter column.
alter table public.professionals
  drop constraint if exists prof_council_required;
alter table public.professionals
  add constraint prof_council_required
  check (role = 'superadmin' or council_id is not null);

create index if not exists ples_council_idx        on public.ples(council_id);
create index if not exists audit_scores_council_idx on public.audit_scores(council_id);
create index if not exists professionals_council_idx on public.professionals(council_id);


-- ========================= RUN 2 — RLS / POLICIES ==========================

alter table public.councils      enable row level security;
alter table public.council_slots enable row level security;

-- councils: any authenticated user may read (needed for the sign-up council picker);
-- only the superadmin writes (mirrors app_settings/documents).
drop policy if exists "councils: authenticated read" on public.councils;
create policy "councils: authenticated read"
  on public.councils for select using (auth.role() = 'authenticated');
drop policy if exists "councils: superadmin write" on public.councils;
create policy "councils: superadmin write"
  on public.councils for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- council_slots: admins read, superadmin writes (mirrors role_slots).
drop policy if exists "council_slots: admin read" on public.council_slots;
create policy "council_slots: admin read"
  on public.council_slots for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
drop policy if exists "council_slots: superadmin write" on public.council_slots;
create policy "council_slots: superadmin write"
  on public.council_slots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- ---- Split every blanket "admin all" policy into superadmin-all + admin-own-council.
-- Defense-in-depth only: the backend uses the service-role key and bypasses RLS, so the
-- ROUTES are the load-bearing scope. These keep a future direct-JWT client correctly scoped.

-- professionals: superadmin reads all; admin reads only their council (+ self via "prof: own read").
drop policy if exists "prof: admin read all" on public.professionals;
create policy "prof: superadmin read all"
  on public.professionals for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "prof: admin read own council"
  on public.professionals for select using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = professionals.council_id)
  );

-- ple_folders: admin read scoped via the folder's physician's council.
drop policy if exists "folders: admin read" on public.ple_folders;
create policy "folders: superadmin read"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "folders: admin read own council"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals me
            join public.professionals owner on owner.id = ple_folders.physician_id
            where me.id = auth.uid() and me.role = 'admin' and me.council_id = owner.council_id)
  );

-- ples: superadmin all; admin own-council (uses the denormalized ples.council_id).
drop policy if exists "ples: admin all" on public.ples;
create policy "ples: superadmin all"
  on public.ples for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "ples: admin own council"
  on public.ples for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = ples.council_id)
  );

-- messages: scope through the parent ple's denormalized council_id.
drop policy if exists "msg: admin all" on public.messages;
create policy "msg: superadmin all"
  on public.messages for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "msg: admin own council"
  on public.messages for all using (
    exists (select 1 from public.professionals p
            join public.ples pl on pl.id = messages.ple_id
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = pl.council_id)
  );

-- ai_evaluations: scope through the parent ple's council_id.
drop policy if exists "ai_eval: admin all" on public.ai_evaluations;
create policy "ai_eval: superadmin all"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "ai_eval: admin own council"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p
            join public.ples pl on pl.id = ai_evaluations.ple_id
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = pl.council_id)
  );

-- audit_scores: superadmin all; admin own-council (denormalized audit_scores.council_id).
drop policy if exists "audit: admin all" on public.audit_scores;
create policy "audit: superadmin all"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "audit: admin own council"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = audit_scores.council_id)
  );

-- lpdp_snapshots: scope through the snapshot's physician's council.
drop policy if exists "lpdp: admin all" on public.lpdp_snapshots;
create policy "lpdp: superadmin all"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "lpdp: admin own council"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals me
            join public.professionals subj on subj.id = lpdp_snapshots.physician_id
            where me.id = auth.uid() and me.role = 'admin' and me.council_id = subj.council_id)
  );

-- access_requests: superadmin all; admin only their council's requests.
drop policy if exists "requests: admin all" on public.access_requests;
create policy "requests: superadmin all"
  on public.access_requests for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
create policy "requests: admin own council"
  on public.access_requests for all using (
    exists (select 1 from public.professionals p
            where p.id = auth.uid() and p.role = 'admin' and p.council_id = access_requests.council_id)
  );

-- ---- Backstop trigger: an auditor may never score a session of another council,
-- nor their own session. Guarantees the invariant even against a buggy future route
-- or a direct service-role write (which bypasses RLS).
create or replace function public.audit_scores_guard()
returns trigger language plpgsql as $$
declare
  v_ple_council uuid;
  v_physician   uuid;
  v_aud_council uuid;
begin
  select council_id, physician_id into v_ple_council, v_physician
    from public.ples where id = new.ple_id;
  select council_id into v_aud_council
    from public.professionals where id = new.auditor_id;

  if new.auditor_id = v_physician then
    raise exception 'An auditor cannot score their own session (auditor = physician).';
  end if;
  if v_aud_council is distinct from v_ple_council then
    raise exception 'Cross-council audit is not allowed (auditor council <> session council).';
  end if;
  -- keep the denormalized council in sync with the session
  new.council_id := v_ple_council;
  return new;
end;
$$;

drop trigger if exists audit_scores_guard_trg on public.audit_scores;
create trigger audit_scores_guard_trg
  before insert on public.audit_scores
  for each row execute function public.audit_scores_guard();
