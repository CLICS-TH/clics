// Single source of truth for the "Special" dual-role rule: can_audit (auditor rights) is meaningful
// ONLY for a physician. Every write path that sets can_audit — POST /admin/users, PATCH /admin/users/:id,
// and POST /admin/invites — runs the requested flag through here so it can NEVER ride on an admin or
// auditor. (The service-role backend bypasses RLS, so this normalization is load-bearing, not cosmetic.)
function normalizeCanAudit(role, canAudit) {
  return role === 'physician' && canAudit === true;
}

module.exports = { normalizeCanAudit };
