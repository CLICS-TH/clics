// The one place the scripts learn where the production backend lives. Production runs on vm1
// (ADR 0002, ADR 0012), where one origin serves the Portal (/), the dashboard (/audit) and the backend
// under /api (#429); Railway is only the rollback until its day-7 stop, and serves the backend at its root.
// apiOrigin() is the base every backend path is appended to. To aim a script elsewhere, set
// CLICS_API_ORIGIN (every script) or the script's own variable (SMOKE_BASE, SOAK_BASE, ...).
// To roll the scripts back to Railway: CLICS_API_ORIGIN=$(node -p "require('./scripts/lib/api-origin.cjs').RAILWAY_ORIGIN").
const SITE_ORIGIN = 'https://clics.ccme.or.th';
const VM1_API_BASE = `${SITE_ORIGIN}/api`;
const RAILWAY_ORIGIN = 'https://backend-production-c12e4.up.railway.app';

function apiOrigin(own) {
  const raw = String(own || process.env.CLICS_API_ORIGIN || VM1_API_BASE).trim();
  return raw.replace(/\/+$/, '');
}

module.exports = { SITE_ORIGIN, VM1_API_BASE, RAILWAY_ORIGIN, apiOrigin };
