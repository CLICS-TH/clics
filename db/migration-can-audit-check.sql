-- Migration: enforce the "Special" dual-role invariant at the DB layer.
--
-- can_audit (physician + auditor rights) must ride ONLY on a physician. The app normalizes this in
-- one place (lib/dual-role.normalizeCanAudit) on create/edit/invite, but POST
-- /admin/auditor-requests/:id/approve flipped can_audit=true keyed on a stale request row without
-- re-checking the professional's current role/status — so a since-promoted (admin/auditor) account
-- could end up with can_audit=true. This CHECK makes that impossible regardless of code path.
--
-- Safe to run more than once.

-- 1) Repair any existing violators first (the flag is meaningless off a physician).
update public.professionals set can_audit = false
  where can_audit = true and role <> 'physician';

-- 2) Enforce going forward.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'can_audit_physician_only') then
    alter table public.professionals
      add constraint can_audit_physician_only check (can_audit = false or role = 'physician');
  end if;
end $$;
