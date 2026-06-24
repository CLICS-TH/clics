-- db/migration-compensation-payout.sql
-- Compensation payout pipeline (CLICS §12): ฿500 per completed (cle_pass) CLE, superadmin-configurable
-- rate + cap. Physicians provide their own payment details (encrypted on-prem with IDENTITY_ENC_KEY,
-- exactly like oauth_identities); the superadmin views amount owed, marks each paid with a reference,
-- and exports a payout file. No money-movement API — the actual transfer is done externally.
-- Safe to re-run (idempotent).
-- ===========================================================================

-- Payment details vault: one encrypted blob per physician (bank / account / PromptPay). The blob is
-- produced by lib/crypto.encryptJson and is meaningless without IDENTITY_ENC_KEY. DENY-ALL RLS (no
-- policy) — the service-role backend is the ONLY reader/writer, mirroring oauth_identities.
create table if not exists public.payment_info (
  physician_id uuid primary key references public.professionals(id) on delete cascade,
  enc          text not null,
  updated_at   timestamptz not null default now()
);
alter table public.payment_info enable row level security;  -- DENY-ALL: no policy → only service role

-- Payout ledger: one row per completed payment. "Owed" is computed live from cle_pass counts × rate
-- (capped); "outstanding" = owed − Σ(ledger amount). cle_count snapshots the count paid against.
create table if not exists public.payouts (
  id           uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id) on delete cascade,
  cle_count    int  not null default 0,
  amount_thb   numeric not null,
  paid_ref     text,
  paid_by      uuid references public.professionals(id),
  paid_at      timestamptz not null default now()
);
create index if not exists payouts_physician_idx on public.payouts (physician_id);
alter table public.payouts enable row level security;  -- DENY-ALL: superadmin acts via service role

-- Configurable compensation: rate per completed CLE and the per-physician cap in CLEs (0 = no cap).
insert into public.app_settings (key, value) values ('comp_rate_thb', 500) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('comp_cap_cles', 3)   on conflict (key) do nothing;
