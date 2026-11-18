// The database-move window (#432, ADR 0012): CLICS_MAINTENANCE=1 makes the backend write nothing.
//
// Every request except /health and /health/deep gets a 503, reads included: some GET routes write an
// audit_log row (logEvent), so refusing only POST/PUT/PATCH/DELETE would still write to the source while
// it is being dumped, and the verify report would then fail on a table that moved under it. index.js
// also leaves the eval drain and the reconcile sweep unstarted while the switch is on.
//
// Exactly '1' turns it on. Anything else, a blank included, is off, so a stray value never takes the
// service down by accident; the runbook checks /health/deep reports `maintenance: true` before the dump.
const maintenanceOn = () => process.env.CLICS_MAINTENANCE === '1';

const MESSAGE = 'CLICS is moving its database. Sign-in and every page come back when the move is done.';

function refuseDuringMaintenance(req, res, next) {
  if (!maintenanceOn()) return next();
  if (req.path === '/health' || req.path.startsWith('/health/')) return next();
  res.set('Retry-After', '1800');
  return res.status(503).json({ error: MESSAGE, maintenance: true });
}

module.exports = { maintenanceOn, refuseDuringMaintenance, MAINTENANCE_MESSAGE: MESSAGE };
