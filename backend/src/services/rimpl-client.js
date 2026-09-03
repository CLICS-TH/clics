const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';
// A chat may make up to 2 Claude calls (initial + citation retry) AND wait in RIMPL's concurrency
// queue under load, so the wrapper timeout must cover queue-wait + generation. Env-tunable; raised
// from 75s -> 100s to recover burst-tail calls that previously aborted while queued.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
// Evaluation timeout must cover RIMPL's concurrency-queue wait + one provider attempt + retries —
// the old hard-coded 30s aborted burst-tail evals (end-of-cohort) while they were still queued,
// mis-routing sessions to manual QA / stranding credit.
//
// 180s, no longer defaulting to the chat value: both providers now use a 150s client ceiling (the
// on-prem model measured 82.5s and 87.8s on real transcripts, so the previous 85s sat mid-
// distribution). This outer bound MUST stay above that inner one — invert them and the backend hangs
// up on an evaluation the provider was about to return, which reads as a provider failure in the
// logs and costs the physician their credit for a call that actually succeeded.
//
// 480s since the evaluation drain: the PIS-7 call left the physician's HTTP path entirely (it is
// claimed from the ple_pass queue in the background), and with the consistency layer a local
// evaluation is 2–3 serial ~70s calls plus rimpl's own queue wait. The criteria call is different —
// it still runs inside /end while the physician waits — so it keeps its own, shorter ceiling.
const EVAL_TIMEOUT_MS = parseInt(process.env.RIMPL_EVAL_TIMEOUT_MS || '480000', 10);
const CRITERIA_TIMEOUT_MS = parseInt(process.env.RIMPL_CRITERIA_TIMEOUT_MS || '180000', 10);

// A RIMPL HTTP error with the status attached, so callers can tell a DETERMINISTIC bad-output
// failure (400 bad request / 422 / 502 "evaluator returned out-of-range/invalid output") — which a
// retry can never fix — from a TRANSIENT one (500 infra / timeout / network) worth retrying. Without
// this, the reconcile sweep retries a deterministically-failing eval forever, re-paying Anthropic.
async function rimplError(path, res) {
  const status = typeof res === 'number' ? res : res?.status;
  const err = new Error(`RIMPL ${path} error: ${status}`);
  err.status = status;
  // rimpl's queue/size errors carry a machine-readable body ({ code, retry_after_s }) and, for a
  // full queue, a Retry-After header. Surface both so the drain can back off by the server's own
  // estimate rather than a guess, and so a 413 can be told apart from any other deterministic 4xx.
  if (res && typeof res === 'object') {
    let body = null;
    try { body = typeof res.json === 'function' ? await res.json() : null; } catch { body = null; }
    if (body && typeof body === 'object') {
      if (typeof body.code === 'string') err.code = body.code;
      if (typeof body.error === 'string') err.detail = body.error.slice(0, 200);
      const ra = Number(body.retry_after_s);
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
    }
    const hdr = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(hdr) && hdr > 0) err.retryAfterMs = hdr * 1000;
  }
  return err;
}

// 400/422/502 from RIMPL are deterministic (malformed request / validation / un-parseable or
// out-of-range model output). A 401/403 is an INTERNAL_TOKEN misconfig — also not self-healing.
// 413 is the transcript exceeding the evaluator's context (rimpl's proactive backstop or the body
// limit): re-sending the same oversized transcript cannot make it fit, so it must route to a human,
// not loop. 503 (queue full / provider down) and 429 stay transient — the drain backs off on them.
const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 413, 422, 502]);
function isDeterministicRimplError(err) {
  return err && typeof err.status === 'number' && DETERMINISTIC_STATUSES.has(err.status);
}

// rimpl now routes each AI call to a provider — the Anthropic cloud, or the on-prem local model —
// and reports which one ACTUALLY served the call on every response. Stamp it on the parsed body so
// no caller downstream has to guess when it prices the call.
//
// The fallback is 'anthropic' on purpose, i.e. the PAID rate: an older rimpl that predates the
// provider field (or a partial rollout) must make the backend over-bill, never silently meter real
// cloud spend at $0 — that would defeat the per-user budget cap and under-invoice the council.
const DEFAULT_PROVIDER = 'anthropic';
async function parseWithProvider(res) {
  const body = await res.json();
  if (body && typeof body === 'object' && !body.provider) body.provider = DEFAULT_PROVIDER;
  return body;
}

// `patient_ref` (the physician's structured patient identifier) is forwarded to RIMPL on-prem SOLELY
// so RIMPL can scrub it from the narrative/transcript before any cloud call — it is never forwarded
// to the cloud AI. See docs/constraints.md (data boundary).
async function rimplChat({ ple_id, history, message, language, chief_complaint, patient_ref, socratic, artifacts, rescue_active, already_qualified }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    // rescue_active / already_qualified are latches from the `ples` row. RIMPL is stateless, so
    // without them it would re-run the qualifying classifier on every turn past the fourth.
    body: JSON.stringify({ ple_id, history, message, language, chief_complaint, patient_ref,
      socratic: !!socratic, artifacts: !!artifacts,
      rescue_active: !!rescue_active, already_qualified: !!already_qualified }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/chat', res);
  return parseWithProvider(res);
}

// Auditor calibration chat: discuss a PLE's AI evaluation vs the auditor's own scores. The transcript
// is sent so RIMPL can de-identify it on-prem before the cloud call (stored raw); patient_ref gives
// the scrub hints. Metered against the auditor's SEPARATE budget pool by the caller.
async function rimplAuditDiscuss({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref }) {
  const res = await fetch(`${RIMPL_URL}/audit-discuss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/audit-discuss', res);
  return parseWithProvider(res);
}

// `shadow: false` opts out of RIMPL's shadow evaluation. Only the calibration harness sets it: a
// --mode rescore run re-scores the real cohort through this route and would otherwise overwrite the
// pilot's accumulated shadow rows with calibration-run rows.
async function rimplEvaluate({ ple_id, transcript, patient_ref, shadow, weights_sha256 }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    // weights_sha256: the DECLARED Model Lock checksum (§10.2). RIMPL cannot read it — the weights
    // file sits on the DGX, not behind the inference API — so it is stamped onto the score from the
    // declaration instead, and its absence is recorded as "not locked" rather than hidden.
    body: JSON.stringify({ ple_id, transcript, patient_ref, shadow, weights_sha256: weights_sha256 ?? null }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/evaluate', res);
  return parseWithProvider(res);
}

async function rimplEvaluateCriteria({ transcript, patient_ref }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript, patient_ref }),
    signal: AbortSignal.timeout(CRITERIA_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/evaluate-criteria', res);
  return parseWithProvider(res);
}

// Readiness probe for the backend's GET /health/deep: fetch RIMPL's own deep check and return its
// HTTP status + parsed body WITHOUT throwing on a non-200 (unlike the chat/eval calls — here a 503
// is a meaningful "RIMPL degraded" answer, not a transport failure). Network/timeout still throws,
// which the health route maps to a `down` rimpl status. Short timeout — this is an ops probe.
const HEALTH_PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_RIMPL_TIMEOUT_MS || '2500', 10);
async function probeRimplDeep({ timeoutMs = HEALTH_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/health/deep`, {
    method: 'GET',
    headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' }, // harmless; /health/deep is open
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { httpStatus: res.status, body };
}

// Ask RIMPL whether a provider is fit to serve a purpose, BEFORE switching to it. Separate from
// probeRimplDeep because that reports what is already running; this asks about something that is
// not running yet, which is the only question a switch gate cares about.
//
// Longer timeout than the deep probe: an embedding probe makes a real vendor round-trip, and this
// runs on a deliberate admin action rather than a monitor's schedule.
const PROVIDER_PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_PROVIDER_PROBE_TIMEOUT_MS || '20000', 10);
async function probeRimplProvider({ name, purpose = 'chat', timeoutMs = PROVIDER_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/health/provider/${encodeURIComponent(name)}?purpose=${encodeURIComponent(purpose)}`, {
    headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RIMPL provider probe returned ${res.status}`);
  return res.json();
}

module.exports = { rimplChat, rimplAuditDiscuss, rimplEvaluate, rimplEvaluateCriteria, isDeterministicRimplError, RIMPL_URL, probeRimplDeep, probeRimplProvider, DEFAULT_PROVIDER };
