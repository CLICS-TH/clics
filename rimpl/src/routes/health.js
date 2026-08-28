// Deep readiness check for RIMPL (P1 observability). The shallow GET /health (src/index.js) stays a
// pure liveness ping for the load balancer; GET /health/deep probes the runtime dependencies so a
// degraded RIMPL surfaces cleanly (503 + a per-dependency map) instead of as a per-message 502.
// Mounted BEFORE the x-internal-token gate so monitors can reach it unauthenticated, like /health.
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { readiness, activeProviders, modelsByPurpose, providerSettingsStatus, probeProvider } = require('../services/ai');
const { internalAuth } = require('../lib/internal-auth');

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

// The single model this deployment runs, or null when purposes are split across providers — in which
// case `models` below is the authoritative answer. Reporting one provider's model under a hybrid
// would tell an operator that PIS-7 scoring runs on a model it does not run on.
// Never throws: an unknown AI_PROVIDER surfaces as a `down` check above, not a crashed health route.
function summaryModel() {
  try {
    const active = activeProviders();
    if (active.length !== 1) return null;
    const purposes = Object.values(modelsByPurpose());
    return purposes[0]?.model ?? null;
  } catch { return null; }
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
  // Probe only the providers this deployment actually uses (services/ai.js resolves them from
  // AI_PROVIDER*), so an all-local deployment is not reported degraded for a missing cloud key —
  // and a hybrid is reported degraded if EITHER side is down.
  let providerChecks;
  try {
    providerChecks = await readiness();
  } catch (e) {
    providerChecks = { ai_provider: { status: 'down', error: e?.message || String(e) } };
  }

  const checks = {
    ...providerChecks,
    supabase: await checkSupabase(),
  };

  const allUp = Object.values(checks).every((c) => c.status === 'up');
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    service: 'rimpl',
    model: summaryModel(),
    providers: activeProviders(),
    // Per-purpose truth — the only field that stays correct under a hybrid.
    models: (() => { try { return modelsByPurpose(); } catch { return null; } })(),
    // WHERE that routing came from. The provider is now a superadmin toggle layered over env, and a
    // box that believes it is database-controlled while silently running on env (bad credentials,
    // unreachable Supabase) looks identical from the outside — `models` would report the env answer
    // with no hint that the toggle is being ignored. This makes that difference visible.
    routing: (() => { try { return providerSettingsStatus(); } catch { return null; } })(),
    checks,
  });
});

// Is a provider fit to serve, asked BEFORE switching to it — so it is asked about a provider that is
// not active and therefore is not covered by /deep above.
//
// GATED, unlike every other route in this router. This router is mounted ahead of the shared-secret
// check so monitors can reach /health and /health/deep unauthenticated, and those are safe because
// they are read-only probes of what is already running. This one is not: probing an embedding
// provider has to actually embed a string, which costs money at a vendor. One route inside an open
// router needing its own guard is worth the oddity; moving it elsewhere would separate it from the
// readiness code it belongs beside.
//
// It reuses the SAME middleware src/index.js mounts, not a copy of it. The copy this replaced had
// dropped the no-token dev carve-out, so a local stack got a 401 from this one route and a 200 from
// every other.
router.get('/provider/:name', internalAuth, async (req, res) => {
  const purpose = String(req.query.purpose || 'chat');
  try {
    // Never 503 on unfit. Unfit IS the answer, and the caller is a gate that needs to read the
    // verdict — a non-200 would make "the probe failed" and "the provider failed" look alike.
    res.json(await probeProvider(String(req.params.name), purpose));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
