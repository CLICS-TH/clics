-- CLICS — enforce the "exactly one superadmin" invariant at the database level.
--
-- The API already blocks every path to a 2nd superadmin (superadmin absent from the create/update
-- role enums, the role_slots pool caps it at 1, approval can't grant it, and its role/status are
-- locked in routes/superadmin.js). This partial unique index makes the singleton guarantee hold even
-- against a direct DB write: at most one professionals row may have role = 'superadmin'.
--
-- Idempotent + single statement (no RLS/transaction gotcha) — safe to run in the Supabase SQL editor.
-- Safe to apply now: exactly one superadmin row currently exists.

create unique index if not exists professionals_single_superadmin
  on public.professionals ((role)) where role = 'superadmin';
