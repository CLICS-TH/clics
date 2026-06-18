// Deep readiness check for RIMPL (P1 observability). The shallow GET /health (src/index.js) stays a
// pure liveness ping for the load balancer; GET /health/deep probes the runtime dependencies so a
// degraded RIMPL surfaces cleanly (503 + a per-dependency map) instead of as a per-message 502.
// Mounted BEFORE the x-internal-token gate so monitors can reach it unauthenticated, like /health.
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { MODEL, isAnthropicClientReady } = require('../services/claude');

const router = Router();

// Probes never block forever: tune the supabase timeout via env (also lets tests run it fast).
const SUPABASE_TIMEOUT_MS = parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || '2000', 10);

// Race a promise against a rejecting timer; the timer is unref'd so it can't keep the process alive.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    timeout,
  ]);
}

async function checkSupabase() {
  try {
    // Cheapest possible round-trip: a HEAD-style exact count, no row payload (mirrors lib/accounts.js).
    const { error } = await withTimeout(
      supabase.from('professionals').select('id', { count: 'exact', head: true }).limit(1),
      SUPABASE_TIMEOUT_MS,
    );
    if (error) return { status: 'down', error: error.message || String(error) };
    return { status: 'up' };
  } catch (e) {
    return { status: 'down', error: e.message };
  }
}

router.get('/deep', async (_req, res) => {
  let ready = { keyPresent: false, constructible: false };
  try { ready = isAnthropicClientReady(); } catch { /* treated as not-ready below */ }

  const checks = {
    anthropic_key: ready.keyPresent
      ? { status: 'up' }
      : { status: 'down', error: 'ANTHROPIC_API_KEY not set' },
    anthropic_client: ready.constructible
      ? { status: 'up' }
      : { status: 'down', error: ready.keyPresent ? 'Anthropic client not constructible' : 'ANTHROPIC_API_KEY not set' },
    supabase: await checkSupabase(),
  };

  const allUp = Object.values(checks).every((c) => c.status === 'up');
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    service: 'rimpl',
    model: MODEL,
    checks,
  });
});

module.exports = router;
