-- CLICS — informed-consent timestamp for the real-participant pilot.
-- A physician must record consent (POST /auth/consent) before any session can start
-- (backend gates POST /ples on this). Idempotent single statement — run in the Supabase SQL editor.
alter table public.professionals add column if not exists consented_at timestamptz;
