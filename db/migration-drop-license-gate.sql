-- migration-drop-license-gate.sql
-- Disable the License No. / TMC verification gate (manager decision, 2026-06-09).
--
-- Onboarding is now Google self-service (physicians) + A/B invite links (physicians + auditors).
-- An A/B invite alone activates an auditor — there is NO license check. We KEEP the license_*
-- columns on professionals and the license_verifications table DORMANT (nullable, no longer
-- written) so this is fully reversible; only the ENFORCING TRIGGER is removed here.
--
-- Idempotent. Run once via the Supabase SQL editor (or psql). No RLS changes; single run.

drop trigger if exists enforce_auditor_license_trg on public.professionals;
drop function if exists public.enforce_auditor_license();
