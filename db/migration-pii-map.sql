-- db/migration-pii-map.sql
-- P2 — reversible on-prem PII map (CLICS_Proposal §9.2, Tier-1 audit). The closing half of the PII
-- pseudonymization item: one AES-256-GCM-encrypted token->raw map per CLE so the PI / data custodian
-- can re-identify a [NAME-n]/[HN-n] token for audit or regulatory inquiry, while the cloud boundary
-- holds (the map is built on-prem from text RIMPL already de-identified; nothing extra reaches cloud).
--
-- Mirrors the oauth_identities vault: encrypted with IDENTITY_ENC_KEY (backend-only) + RLS DENY-ALL
-- (no permissive policy → only the service-role key can read/write; even superadmin reads via the
-- gated, audit-logged GET /admin/cles/:id/pii-map endpoint). RIMPL never touches this table (no key).
--
-- Additive + idempotent. Safe to deploy code before applying: the backend write is fail-soft, so maps
-- simply don't persist until this table exists.
begin;

create table if not exists public.cle_pii_map (
  cle_id        uuid primary key references public.cles(id) on delete cascade,
  map_encrypted text not null,           -- AES-256-GCM(JSON [{token,category,value}]) — never plaintext at rest
  entry_count   int not null default 0,  -- non-PII metadata (number of distinct tokens)
  updated_at    timestamptz not null default now()
);

alter table public.cle_pii_map enable row level security;
-- DENY-ALL: RLS enabled with NO permissive policy, so every non-service-role request is rejected.
-- Only the backend's service-role key (which bypasses RLS) can read/write the map.

commit;
