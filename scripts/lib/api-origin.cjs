// The one place the scripts learn where the production backend lives. Production runs on vm1
// (ADR 0002, ADR 0012); Railway is only the rollback until its day-7 stop. To aim a script elsewhere,
// set CLICS_API_ORIGIN (every script) or the script's own variable (SMOKE_BASE, SOAK_BASE, ...).
// To roll the scripts back to Railway: CLICS_API_ORIGIN=$(node -p "require('./scripts/lib/api-origin.cjs').RAILWAY_ORIGIN").
const VM1_ORIGIN = 'https://clics.ccme.or.th';
const RAILWAY_ORIGIN = 'https://backend-production-c12e4.up.railway.app';

function apiOrigin(own) {
  const raw = String(own || process.env.CLICS_API_ORIGIN || VM1_ORIGIN).trim();
  return raw.replace(/\/+$/, '');
}

module.exports = { VM1_ORIGIN, RAILWAY_ORIGIN, apiOrigin };
