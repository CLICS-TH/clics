// index.js — CLICS TMC license-verifier microservice.
//
// A deliberately tiny Express surface in front of the fragile Playwright scraper
// (src/scrape.js). It is the real source behind the backend's `tmc_scrape`
// adapter, which calls POST /verify over internal HTTP with an x-internal-token
// header. The backend owns caching / single-flight / circuit-breaking; this
// service just does one scrape per request and reports a definitive-or-
// 'unavailable' result.
//
// Endpoints:
//   GET  /health  -> { status: 'ok' }            (unauthenticated liveness)
//   POST /verify  -> { status, evidence }         (requires x-internal-token)
//
// Auth: a shared secret in INTERNAL_TOKEN. The same value must be set on the
// backend so its adapter's x-internal-token header matches. If INTERNAL_TOKEN is
// unset, /verify is locked (every request 401s) rather than open by default.

const express = require('express');
const { scrapeLicense } = require('./scrape');

const PORT = parseInt(process.env.PORT || '3004', 10);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Liveness — intentionally unauthenticated so platforms can health-check.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Shared-secret guard. Fail closed: no token configured => deny everything.
function requireInternalToken(req, res, next) {
  const provided = req.get('x-internal-token') || '';
  if (!INTERNAL_TOKEN || provided !== INTERNAL_TOKEN) {
    return res.status(401).json({ status: 'unavailable', evidence: { reason: 'unauthorized' } });
  }
  next();
}

app.post('/verify', requireInternalToken, async (req, res) => {
  const { license_number, full_name_th, full_name_en } = req.body || {};

  // Need at least one name to query the TMC form (Name*/Surname* are required).
  if (!full_name_th && !full_name_en) {
    return res.json({
      status: 'unavailable',
      evidence: { reason: 'missing_name', adapter: 'tmc_scrape' },
    });
  }

  try {
    const result = await scrapeLicense({ license_number, full_name_th, full_name_en });
    // scrapeLicense already guarantees a valid {status, evidence} shape and
    // collapses every uncertainty to 'unavailable'.
    return res.json(result);
  } catch (err) {
    // Last-resort safety net: never leak a 500 with no body; never imply a
    // negative ('not_found') from an internal error.
    return res.json({
      status: 'unavailable',
      evidence: { reason: 'handler_exception', message: err && err.message ? err.message : String(err) },
    });
  }
});

// Reject anything else cleanly.
app.use((_req, res) => res.status(404).json({ status: 'unavailable', evidence: { reason: 'not_found_route' } }));

// JSON body-parse errors etc. -> 400, but in the service's vocabulary.
app.use((err, _req, res, _next) => {
  res.status(400).json({ status: 'unavailable', evidence: { reason: 'bad_request', message: err.message } });
});

// Only listen when run directly (so tests can import the app without binding a port).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[license-verifier] listening on :${PORT} (adapter target: TMC checkmd)`);
    if (!INTERNAL_TOKEN) {
      console.warn('[license-verifier] WARNING: INTERNAL_TOKEN is unset — /verify will reject ALL requests.');
    }
  });
}

module.exports = app;
