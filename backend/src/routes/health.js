// Deep readiness check for the backend (P1 observability). The shallow GET /health (src/index.js)
// stays a pure liveness ping; GET /health/deep probes the backend's own Supabase plus RIMPL's deep
// check, so an outage of either surfaces as one clean 503 + a per-dependency map instead of as a
// per-message 502. Unauthenticated, like /health (no verifyJwt on this router).
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { probeRimplDeep } = require('../services/rimpl-client');
const evalDrain = require('../services/eval-drain');
const { resolveScope } = require('../lib/eval-scope');
const { getSetting } = require('../lib/settings');

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

// The stuck signal's floor, and the multiple of the queue's OWN advertised wait above which a
// backlog stops being normal. A flat threshold cannot work: `GET /ples/:id/evaluation` already
// tells a physician "position 11, ~16 min" as a healthy state at the seeded concurrency 1 / p50 90,
// so any fixed grace under that turns a normal cohort afternoon red. The grace therefore scales
// with what the queue itself predicts, and the flat value is only the floor for a short queue.
const QUEUE_STUCK_AFTER_S = parseInt(process.env.HEALTH_QUEUE_STUCK_S || '900', 10);
const QUEUE_STUCK_ETA_MULTIPLE = Number(process.env.HEALTH_QUEUE_STUCK_ETA_MULTIPLE || '3');

// The oldest row the drain is actually ELIGIBLE to claim right now, asking exactly what
// claim_ple_evaluations asks — same status, same eval_next_at predicate, same council partition.
// Anything less faithful reports healthy work as stuck:
//   * a row deferred with backoff has eval_next_at in the future and is being retried correctly;
//   * a row in an excluded council is deliberately nobody's to claim.
// `is_test` is NOT the filter here. It is written from the global pilot_test_mode setting
// (routes/ples.js), which has no relationship to which councils the drain skips — so using it
// both misses real backlogs (during a test window every session is is_test) and invents fake ones
// (one non-test session in an excluded council would wedge this endpoint at 503 forever).
async function oldestClaimableWaitS() {
  const scope = await resolveScope();
  let q = supabase.from('ples').select('eval_enqueued_at')
    .eq('status', 'ple_pass')
    .is('eval_claimed_at', null)   // a leased row is being worked on; an expired lease is re-claimed next tick
    .or(`eval_next_at.is.null,eval_next_at.lte.${new Date().toISOString()}`);
  if (scope.include) q = q.in('council_id', scope.include);
  else if (scope.exclude) q = q.or(`council_id.is.null,council_id.not.in.(${scope.exclude.join(',')})`);
  const { data } = await withTimeout(q.order('eval_enqueued_at', { ascending: true }).limit(1).maybeSingle(), SUPABASE_TIMEOUT_MS);
  return waitSeconds(data?.eval_enqueued_at);
}

// How long this queue says it needs to clear, in the same terms the physician is shown.
async function queueGraceS(queued) {
  const [conc, p50] = await Promise.all([getSetting('eval_drain_concurrency', 1), getSetting('eval_p50_seconds', 90)]);
  const concurrency = Math.max(1, Math.round(Number(conc) || 1));
  const etaS = Math.ceil(Math.max(0, queued) / concurrency) * Math.max(1, Math.round(Number(p50) || 90));
  return Math.max(QUEUE_STUCK_AFTER_S, Math.round(etaS * QUEUE_STUCK_ETA_MULTIPLE));
}

// The evaluation queue, for operators and the sandbox smoke: how many ple_pass rows wait, how many
// are claimed, and how long the oldest unclaimed one has waited.
//
// This check DOES flip the verdict. It used to be informational, and that is precisely how a
// three-day production outage went unnoticed: every session query was failing while /health/deep
// answered 200 "ok". A drain that claims nothing is indistinguishable from a healthy idle one
// unless someone looks at whether the work is actually moving — so look.
//
// Four conditions are unambiguous failure. A merely LONG queue is not one of them: a council on
// `eval_drain_exclude_councils` legitimately leaves rows unclaimed forever, so the stuck signal
// ignores test rows (the sandbox council's sessions are all is_test) and waits out a grace period.
async function checkEvalQueue() {
  const out = { drain: evalDrain.status() };
  try {
    const [{ count: queued }, { data: oldest }, claimableWaitS] = await Promise.all([
      withTimeout(supabase.from('ples').select('id', { count: 'exact', head: true }).eq('status', 'ple_pass'), SUPABASE_TIMEOUT_MS),
      withTimeout(supabase.from('ples').select('eval_enqueued_at').eq('status', 'ple_pass').is('eval_claimed_at', null)
        .order('eval_enqueued_at', { ascending: true }).limit(1).maybeSingle(), SUPABASE_TIMEOUT_MS),
      oldestClaimableWaitS(),
    ]);
    out.queued = Number(queued) || 0;
    out.scoring = out.drain.in_flight;
    out.oldest_wait_s = waitSeconds(oldest?.eval_enqueued_at);
    out.oldest_claimable_wait_s = claimableWaitS;
    out.stuck_after_s = await queueGraceS(out.queued);
  } catch (e) {
    out.error = e.message;
  }

  const reasons = [];
  // The last tick threw. state.lastError is cleared on every success, so a value here means NOW.
  if (out.drain.last_error) reasons.push('last_tick_failed');
  // The council partition resolved to nothing — one typo in the exclude setting stops all scoring.
  if (out.drain.scope?.failed_closed) reasons.push(`scope_failed_closed:${out.drain.scope.failed_closed}`);
  // Could not read the queue at all, so its depth is unknown rather than zero.
  if (out.error) reasons.push('queue_unreadable');
  // Claimable work has waited past a grace derived from the queue's own predicted wait.
  out.stuck = (out.oldest_claimable_wait_s ?? 0) > (out.stuck_after_s ?? QUEUE_STUCK_AFTER_S);
  if (out.stuck) reasons.push('queue_stuck');

  out.status = reasons.length ? 'down' : 'up';
  out.reasons = reasons;
  return out;
}

// Seconds since an enqueue timestamp; 0 when absent or unparseable (nothing is waiting).
function waitSeconds(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0;
}

router.get('/deep', async (_req, res) => {
  const [supabaseCheck, rimplCheck, evalQueue] = await Promise.all([checkSupabase(), checkRimpl(), checkEvalQueue()]);
  const checks = { supabase: supabaseCheck, rimpl: rimplCheck, eval_queue: evalQueue };
  const allUp = supabaseCheck.status === 'up' && rimplCheck.status === 'up' && evalQueue.status !== 'down';
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    service: 'backend',
    checks,
  });
});

module.exports = router;
