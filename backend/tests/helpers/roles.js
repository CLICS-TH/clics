// Shared role fixtures for the cross-role integration suites. Two councils (C1/C2) so isolation can
// be exercised. `consented_at` is set on physicians (the human-subjects consent gate). Shapes mirror
// what verifyJwt attaches to req.user (a professionals row + id/email).
const COUNCIL_A = 'C1';
const COUNCIL_B = 'C2';
const CONSENTED = '2026-01-01T00:00:00Z';

const PHYSICIAN = {
  id: 'phys-1', email: 'phys1@test.local', role: 'physician', status: 'active',
  council_id: COUNCIL_A, consented_at: CONSENTED, usage_cost_usd: 0,
};
const PHYSICIAN_B = { ...PHYSICIAN, id: 'phys-2', email: 'phys2@test.local', council_id: COUNCIL_B };
// "Special" dual role: a physician who ALSO holds auditor rights (can_audit=true).
const SPECIAL = { ...PHYSICIAN, id: 'phys-aud', email: 'special@test.local', can_audit: true };

const AUDITOR = { id: 'aud-1', email: 'aud1@test.local', role: 'auditor', status: 'active', council_id: COUNCIL_A, consented_at: CONSENTED };
const AUDITOR_B = { ...AUDITOR, id: 'aud-2', email: 'aud2@test.local', council_id: COUNCIL_B };

const ADMIN = { id: 'adm-1', email: 'adm1@test.local', role: 'admin', status: 'active', council_id: COUNCIL_A };
const ADMIN_B = { ...ADMIN, id: 'adm-2', email: 'adm2@test.local', council_id: COUNCIL_B };

const SUPERADMIN = { id: 'sa-1', email: 'sa@test.local', role: 'superadmin', status: 'active', council_id: null };

module.exports = {
  COUNCIL_A, COUNCIL_B, CONSENTED,
  PHYSICIAN, PHYSICIAN_B, SPECIAL, AUDITOR, AUDITOR_B, ADMIN, ADMIN_B, SUPERADMIN,
};
