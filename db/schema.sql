-- db/schema.sql

create extension if not exists vector;

-- All users (all 4 roles)
create table public.professionals (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           text not null check (role in ('superadmin','admin','physician','auditor')),
  full_name_th   text not null,
  full_name_en   text not null,
  specialty      text,
  license_number text,
  created_at     timestamptz default now()
);

-- Physician-created folders for organizing conversations (see db/migration-folders.sql)
create table public.ple_folders (
  id           uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id) on delete cascade,
  name         text not null,
  sort_order   integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index ple_folders_physician_idx on public.ple_folders(physician_id);

-- One row per physician session
create table public.ples (
  id               uuid primary key default gen_random_uuid(),
  physician_id     uuid not null references public.professionals(id),
  auditor_id       uuid references public.professionals(id),
  folder_id        uuid references public.ple_folders(id) on delete set null,  -- null = Uncategorized
  title            text,                                                       -- physician-editable label
  chief_complaint  text,
  status           text not null default 'active'
                   check (status in ('active','ended','cle_pass','cle_fail_t1','cle_flag_t2','evaluated')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  turn_count       integer default 0,
  token_count      integer default 0,
  c1_pass boolean, c2_pass boolean, c3_pass boolean,
  c4_pass boolean, c5_pass boolean, c6_pass boolean,
  provider_used    text default 'claude',
  created_at       timestamptz default now()
);
create index ples_folder_idx on public.ples(folder_id);

-- One row per chat turn
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  ple_id            uuid not null references public.ples(id) on delete cascade,
  role              text not null check (role in ('physician','assistant')),
  content           text not null,
  refs              jsonb default '[]'::jsonb,
  socratic_question text,
  token_count       integer default 0,
  created_at        timestamptz default now()
);

-- PIS-7 scored by AI
create table public.ai_evaluations (
  id               uuid primary key default gen_random_uuid(),
  ple_id           uuid not null references public.ples(id) on delete cascade,
  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score  numeric not null,
  domain_rationale jsonb,
  model_version    text not null default 'CCME_LLM_v8.0',
  evaluated_at     timestamptz default now()
);

-- PIS-7 scored by Expert Auditor
create table public.audit_scores (
  id              uuid primary key default gen_random_uuid(),
  ple_id          uuid not null references public.ples(id) on delete cascade,
  auditor_id      uuid not null references public.professionals(id),
  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score numeric not null,
  notes           text,
  scored_at       timestamptz default now()
);

-- RAG knowledge base (seeded via seed-documents.js)
create table public.documents (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  source    text not null,
  content   text not null,
  embedding vector(1536),
  language  text not null check (language in ('th','en')),
  created_at timestamptz default now()
);

-- Per-PLE score history for LPDP chart
create table public.lpdp_snapshots (
  id              uuid primary key default gen_random_uuid(),
  physician_id    uuid not null references public.professionals(id),
  ple_id          uuid not null references public.ples(id),
  composite_score numeric not null,
  domain_scores   jsonb not null,
  snapshot_at     timestamptz default now()
);

-- RLS
alter table public.professionals    enable row level security;
alter table public.ple_folders      enable row level security;
alter table public.ples             enable row level security;
alter table public.messages         enable row level security;
alter table public.ai_evaluations   enable row level security;
alter table public.audit_scores     enable row level security;
alter table public.documents        enable row level security;
alter table public.lpdp_snapshots   enable row level security;

-- professionals policies
create policy "prof: own read"
  on public.professionals for select using (auth.uid() = id);
create policy "prof: admin read all"
  on public.professionals for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "prof: superadmin write"
  on public.professionals for insert with check (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- ple_folders policies
drop policy if exists "folders: physician own" on public.ple_folders;
create policy "folders: physician own"
  on public.ple_folders for all using (physician_id = auth.uid());
drop policy if exists "folders: admin read" on public.ple_folders;
create policy "folders: admin read"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- ples policies
create policy "ples: physician own"
  on public.ples for select using (physician_id = auth.uid());
create policy "ples: auditor assigned"
  on public.ples for select using (auditor_id = auth.uid());
create policy "ples: admin all"
  on public.ples for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "ples: physician insert"
  on public.ples for insert with check (physician_id = auth.uid());
create policy "ples: physician update own"
  on public.ples for update using (physician_id = auth.uid());

-- messages policies
create policy "msg: physician own ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "msg: auditor assigned ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.auditor_id = auth.uid())
  );
create policy "msg: admin all"
  on public.messages for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "msg: physician insert"
  on public.messages for insert with check (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );

-- ai_evaluations policies
create policy "ai_eval: physician own"
  on public.ai_evaluations for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "ai_eval: admin all"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- audit_scores policies
create policy "audit: auditor own"
  on public.audit_scores for all using (auditor_id = auth.uid());
create policy "audit: admin all"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- documents: any authenticated user can read (for RAG)
create policy "docs: authenticated read"
  on public.documents for select using (auth.role() = 'authenticated');
create policy "docs: superadmin write"
  on public.documents for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- lpdp policies
create policy "lpdp: physician own"
  on public.lpdp_snapshots for select using (physician_id = auth.uid());
create policy "lpdp: admin all"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- pgvector similarity search function
create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.75,
  match_count     int   default 3
)
returns table (id uuid, title text, source text, content text, similarity float)
language sql stable as $$
  select
    d.id, d.title, d.source, d.content,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;
