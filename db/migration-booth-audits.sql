create table if not exists public.booth_audits (
  play_id     uuid not null references public.booth_plays(id) on delete cascade,
  auditor_id  uuid not null references public.professionals(id) on delete cascade,
  d1          smallint not null check (d1 between 0 and 5),
  d2          smallint not null check (d2 between 0 and 5),
  d3          smallint not null check (d3 between 0 and 5),
  d4          smallint not null check (d4 between 0 and 5),
  d5          smallint not null check (d5 between 0 and 5),
  d6          smallint not null check (d6 between 0 and 5),
  d7          smallint not null check (d7 between 0 and 5),
  created_at  timestamptz not null default now(),
  constraint booth_audits_pkey primary key (play_id, auditor_id)
);

create index if not exists booth_audits_auditor_idx on public.booth_audits (auditor_id);

-- service_role is in the revoke because Supabase's default privileges grant it every privilege on a new table.
-- The on-delete cascades still remove rows: referential actions run as the table owner.
alter table public.booth_audits enable row level security;
revoke all on table public.booth_audits from public, anon, authenticated, service_role;
grant select, insert on table public.booth_audits to service_role;

comment on table public.booth_audits is
  'Booth case-study audits (#389, ADR 0010): play, auditor, d1-d7, time; one per auditor per play. '
  'Outside pilot data: no ICC, payout, export or calibration reader.';
