-- db/migration-folders.sql
-- Additive, non-destructive. Safe to run on the seeded prod DB (idempotent guards).
-- Adds physician conversation folders + per-conversation title + persisted chief complaint.
-- Apply via Supabase SQL editor (or psql) BEFORE deploying the backend.

-- One row per physician-created folder
create table if not exists public.ple_folders (
  id           uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id) on delete cascade,
  name         text not null,
  sort_order   integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists ple_folders_physician_idx on public.ple_folders(physician_id);

-- Organize + name conversations. folder_id null = "Uncategorized".
-- on delete set null => deleting a folder drops its conversations to Uncategorized (never deletes them).
alter table public.ples add column if not exists folder_id uuid references public.ple_folders(id) on delete set null;
alter table public.ples add column if not exists title text;
alter table public.ples add column if not exists chief_complaint text;

create index if not exists ples_folder_idx on public.ples(folder_id);

-- RLS (belt-and-suspenders; backend uses the service-role key and enforces ownership in-code)
alter table public.ple_folders enable row level security;

drop policy if exists "folders: physician own" on public.ple_folders;
create policy "folders: physician own"
  on public.ple_folders for all using (physician_id = auth.uid());

drop policy if exists "folders: admin read" on public.ple_folders;
create policy "folders: admin read"
  on public.ple_folders for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
