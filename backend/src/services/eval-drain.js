// The evaluation drain: the ONLY thing that starts a PIS-7 evaluation.
//
// The `ples` row at status 'ple_pass' is the queue. /end, admin approve and the reconcile sweep now
// ENQUEUE (set eval_enqueued_at) and kick() this drain; nothing calls triggerEvaluation directly any
// more. That single-writer shape is what makes the guarantees hold:
//   * FIFO — claim_ple_evaluations() hands out the oldest rows first;
//   * bounded — at most `eval_drain_concurrency` (setting; env EVAL_DRAIN_CONCURRENCY) in flight
//     from THIS process, so a burst of submissions cannot fan out onto the box;
//   * no duplicates — the SQL claim is FOR UPDATE SKIP LOCKED under a lease, and a backend timeout
//     no longer re-POSTs a duplicate while the original still waits (attempts:1 per claim);
//   * fail closed — a transient failure (queue full, timeout, provider down) defers the row with
//     backoff and NEVER drops it; only a deterministic failure or exhausted attempts routes it to
//     manual QA (ple_flag_t2), which is what the reconcile sweep always did.
//
// The local evaluator measured p50 ~70s and the box serves ~2 calls at once (docs/GATE0-DGX-RESULTS.md
// §7), so the physician-facing "queued (position N)" state is computed from eval_enqueued_at order
// by GET /ples/:id/evaluation — not from anything in-memory here.
const { supabase } = require('../lib/supabase');
const { getSetting } = require('../lib/settings');
const { logEvent } = require('../lib/audit');
const { resolveScope } = require('../lib/eval-scope');
const { triggerEvaluation } = require('./ple-evaluation');
const { isDeterministicRimplError } = require('./rimpl-client');
const { budgetPool } = require('../lib/usage');
const { loadTranscriptForEvaluation } = require('./eval-transcript');

const INTERVAL_MS = parseInt(process.env.EVAL_DRAIN_INTERVAL_MS || '60000', 10);
const ENV_CONCURRENCY = Math.max(1, parseInt(process.env.EVAL_DRAIN_CONCURRENCY || '1', 10));
const LEASE_S = Math.max(60, parseInt(process.env.EVAL_LEASE_S || '600', 10));
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.EVAL_MAX_ATTEMPTS || '20', 10));
const MAX_BACKOFF_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;

const state = {
  running: false, inFlight: 0, ticking: false, kicked: false, timer: null,
  lastTickAt: null, lastError: null, claimed: 0, evaluated: 0, deferred: 0, flagged: 0,
  // Last budget-pool reading, and whether the pause has already been announced.
  pool: null, poolWasExhausted: false,
};

// Honour the provider's Retry-After when rimpl said "queue full"; otherwise exponential, capped,
// jittered so a whole backlog does not wake at the same second.
function backoffMs(attempts, err) {
  const base = err?.retryAfterMs > 0 ? err.retryAfterMs : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  return base + Math.floor(Math.random() * 5_000);
}

async function concurrency() {
  const v = await getSetting('eval_drain_concurrency', ENV_CONCURRENCY);
  return Math.max(1, Math.min(8, Math.round(Number(v) || ENV_CONCURRENCY)));
}

// Route to manual QA — but ONLY if the row is still ple_pass. persistEvaluation flips the row to
// 'evaluated' before a later step (usage accrual) can throw; flagging unconditionally here would
// overwrite an earned score.
async function flag(pleId, reason, action, ple) {
  const { error } = await supabase.from('ples')
    .update({ status: 'ple_flag_t2', eval_claimed_at: null, eval_last_error: reason })
    .eq('id', pleId).eq('status', 'ple_pass');
  if (error) console.error(`[eval-drain] PLE ${pleId}: flag write failed: ${error.message}`);
  state.flagged++;
  await logEvent({ action, targetType: 'ple', targetId: pleId, councilId: ple?.council_id ?? null,
    metadata: { reason, attempts: ple?.eval_attempts ?? null } }).catch(() => {});
}

async function defer(pleId, attempts, err) {
  const ms = backoffMs(attempts, err);
  const { error } = await supabase.from('ples')
    .update({ eval_claimed_at: null, eval_next_at: new Date(Date.now() + ms).toISOString(),
      eval_last_error: `${err?.status ?? 'transient'}:${err?.code ?? err?.message ?? 'error'}`.slice(0, 200) })
    .eq('id', pleId).eq('status', 'ple_pass');
  if (error) console.error(`[eval-drain] PLE ${pleId}: defer write failed: ${error.message}`);
  state.deferred++;
  return ms;
}

async function runOne(pleId) {
  state.inFlight++;
  let ple = null;
  try {
    const loaded = await loadTranscriptForEvaluation(pleId);
    if (!loaded) { const e = new Error('ple row unreadable'); e.status = 503; e.code = 'ple_unreadable'; throw e; }
    ple = loaded.ple;
    if (ple.status !== 'ple_pass') return; // raced with something that already moved it on
    if (!loaded.transcript) {
      // 'empty' can never self-heal (a passed PLE with zero messages is a data fault) — deterministic,
      // so a human sees it instead of the drain deferring it every backoff forever.
      const e = new Error(`transcript ${loaded.reason}`); e.code = `transcript_${loaded.reason}`;
      e.status = loaded.reason === 'empty' ? 422 : 503;
      throw e;
    }
    await triggerEvaluation(pleId, loaded.transcript, ple.physician_id, loaded.patientRef, { attempts: 1 });
    const { error } = await supabase.from('ples')
      .update({ eval_claimed_at: null, eval_last_error: null }).eq('id', pleId);
    if (error) console.error(`[eval-drain] PLE ${pleId}: post-evaluate clear failed: ${error.message}`);
    state.evaluated++;
  } catch (e) {
    const attempts = ple?.eval_attempts ?? 1;
    if (isDeterministicRimplError(e)) {
      console.error(`[eval-drain] PLE ${pleId}: deterministic failure (${e.status}${e.code ? ' ' + e.code : ''}) -> manual QA`);
      await flag(pleId, `deterministic:${e.status}${e.code ? ':' + e.code : ''}`, 'ple.eval_deterministic_failure', ple);
    } else if (attempts >= MAX_ATTEMPTS) {
      console.error(`[eval-drain] PLE ${pleId}: ${attempts} attempts exhausted -> manual QA (last: ${e.message})`);
      await flag(pleId, `exhausted:${attempts}:${e?.code ?? e?.message ?? ''}`.slice(0, 200), 'ple.eval_exhausted', ple);
    } else {
      const ms = await defer(pleId, attempts, e);
      console.warn(`[eval-drain] PLE ${pleId}: transient (${e.status ?? '-'} ${e.code ?? e.message}) — attempt ${attempts}, retry in ${Math.round(ms / 1000)}s`);
    }
  } finally {
    state.inFlight--;
    kick(); // a freed slot pulls the next queued row immediately
  }
}

// One pass: claim as many rows as there are free slots, then RETURN — the evaluations run in the
// background and each one kicks the next. Concurrent ticks coalesce into one follow-up.
async function tick() {
  if (state.ticking) { state.kicked = true; return; }
  state.ticking = true;
  try {
    const free = (await concurrency()) - state.inFlight;
    if (free <= 0) return;

    // Org-wide budget pool, checked BEFORE the claim rather than before the evaluate call. A claimed
    // row that cannot be evaluated has to be deferred, and deferring burns an eval_attempt — so
    // gating later would march every queued PLE to MAX_ATTEMPTS and flag it for manual QA while the
    // only thing wrong was an unraised cap. Not claiming leaves the queue exactly as it was.
    //
    // Silence is the danger here: a stalled drain looks like an empty queue. state.pool feeds
    // /health/deep, which flips to degraded, and the log line prints on the TRANSITION only — one
    // line an operator will see, not one per tick that nobody reads.
    const pool = await budgetPool();
    state.pool = pool;
    if (pool.exhausted) {
      if (!state.poolWasExhausted) {
        state.poolWasExhausted = true;
        console.error(`[eval-drain] PAUSED — api_budget_pool_usd is $${pool.cap} and $${pool.spent ?? '?'} is spent`
          + `${pool.reason ? ` (${pool.reason})` : ''}. No PLE is claimed until the pool is raised. Queued work is untouched.`);
      }
      return;
    }
    if (state.poolWasExhausted) {
      state.poolWasExhausted = false;
      console.log(`[eval-drain] RESUMED — budget pool has room again ($${pool.spent ?? '?'} of $${pool.cap}).`);
    }
    const scope = await resolveScope();
    state.scope = { exclude_codes: scope.excludeCodes ?? [], include_codes: scope.includeCodes ?? [], failed_closed: scope.failedClosed ?? null };
    const { data, error } = await supabase.rpc('claim_ple_evaluations', {
      p_limit: free, p_lease_seconds: LEASE_S,
      p_exclude_councils: scope.exclude, p_include_councils: scope.include,
    });
    if (error) throw new Error(`claim_ple_evaluations: ${error.message}`);
    const ids = (Array.isArray(data) ? data : []).map((r) => (typeof r === 'string' ? r : r?.id)).filter(Boolean);
    state.claimed += ids.length;
    state.lastError = null;
    for (const id of ids) runOne(id).catch((e) => console.error(`[eval-drain] PLE ${id}: unexpected: ${e.message}`));
  } catch (e) {
    state.lastError = e.message;
    console.error(`[eval-drain] tick failed: ${e.message}`);
  } finally {
    state.ticking = false;
    state.lastTickAt = new Date().toISOString();
    if (state.kicked) { state.kicked = false; setImmediate(() => { tick().catch(() => {}); }); }
  }
}

// Called by every enqueue site and after every completed evaluation. Never throws, never awaits.
function kick() {
  if (!state.running) return;
  setImmediate(() => { tick().catch(() => {}); });
}

function start({ intervalMs = INTERVAL_MS } = {}) {
  if (state.running) return;
  state.running = true;
  if (intervalMs > 0) {
    state.timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (state.timer.unref) state.timer.unref(); // the timer alone must not keep a script that imports `app` alive
  }
  kick();
}

function stop() {
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function status() {
  const { running, inFlight, lastTickAt, lastError, claimed, evaluated, deferred, flagged, pool } = state;
  return { running, in_flight: inFlight, last_tick_at: lastTickAt, last_error: lastError,
    counters: { claimed, evaluated, deferred, flagged }, lease_s: LEASE_S, max_attempts: MAX_ATTEMPTS,
    // The council partition the last tick claimed under; failed_closed set means it claimed NOTHING and why.
    scope: state.scope ?? null,
    // The org-wide budget pool as of the last tick. `exhausted` means the drain claimed nothing.
    pool: pool ?? null };
}

module.exports = { start, stop, kick, tick, status, backoffMs, _state: state };
