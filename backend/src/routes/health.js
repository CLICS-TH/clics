// Deep readiness check for the backend (P1 observability). The shallow GET /health (src/index.js)
// stays a pure liveness ping; GET /health/deep probes the backend's own Supabase plus RIMPL's deep
// check, so an outage of either surfaces as one clean 503 + a per-dependency map instead of as a
// per-message 502. Unauthenticated, like /health (no verifyJwt on this router).
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { probeRimplDeep } = require('../services/rimpl-client');
const evalDrain = require('../services/eval-drain');

const router = Router();

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

async function checkRimpl() {
  try {
    const { httpStatus, body } = await probeRimplDeep();
    // RIMPL reachable but a RIMPL dependency down (503) → backend reports rimpl down + bubbles the body.
    return { status: httpStatus === 200 ? 'up' : 'down', httpStatus, deep: body };
  } catch (e) {
    // Unreachable / timeout — no body to bubble.
    return { status: 'down', error: e.message };
  }
}

// The evaluation queue, for operators and the sandbox smoke: how many ple_pass rows wait, how many
// are claimed, and how long the oldest unclaimed one has waited. Informational — never flips the verdict.
async function checkEvalQueue() {
  const out = { drain: evalDrain.status() };
  try {
    const [{ count: queued }, { data: oldest }] = await Promise.all([
      withTimeout(supabase.from('ples').select('id', { count: 'exact', head: true }).eq('status', 'ple_pass'), SUPABASE_TIMEOUT_MS),
      withTimeout(supabase.from('ples').select('eval_enqueued_at').eq('status', 'ple_pass').is('eval_claimed_at', null)
        .order('eval_enqueued_at', { ascending: true }).limit(1).maybeSingle(), SUPABASE_TIMEOUT_MS),
    ]);
    out.queued = Number(queued) || 0;
    out.scoring = out.drain.in_flight;
    const t = oldest?.eval_enqueued_at ? Date.parse(oldest.eval_enqueued_at) : NaN;
    out.oldest_wait_s = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

router.get('/deep', async (_req, res) => {
  const [supabaseCheck, rimplCheck, evalQueue] = await Promise.all([checkSupabase(), checkRimpl(), checkEvalQueue()]);
  const checks = { supabase: supabaseCheck, rimpl: rimplCheck, eval_queue: evalQueue };
  const allUp = supabaseCheck.status === 'up' && rimplCheck.status === 'up';
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    service: 'backend',
    checks,
  });
});

module.exports = router;
