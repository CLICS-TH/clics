const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';
// A chat may make up to 2 Claude calls (initial + citation retry) AND wait in RIMPL's concurrency
// queue under load, so the wrapper timeout must cover queue-wait + generation. Env-tunable; raised
// from 75s -> 100s to recover burst-tail calls that previously aborted while queued.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
// Evaluation timeout must cover RIMPL's concurrency-queue wait + one Claude attempt (55s SDK
// timeout) + retries — the old hard-coded 30s aborted burst-tail evals (end-of-cohort) while they
// were still queued, mis-routing sessions to manual QA / stranding credit. Default to the chat value.
const EVAL_TIMEOUT_MS = parseInt(process.env.RIMPL_EVAL_TIMEOUT_MS || `${CHAT_TIMEOUT_MS}`, 10);

// A RIMPL HTTP error with the status attached, so callers can tell a DETERMINISTIC bad-output
// failure (400 bad request / 422 / 502 "evaluator returned out-of-range/invalid output") — which a
// retry can never fix — from a TRANSIENT one (500 infra / timeout / network) worth retrying. Without
// this, the reconcile sweep retries a deterministically-failing eval forever, re-paying Anthropic.
function rimplError(path, status) {
  const err = new Error(`RIMPL ${path} error: ${status}`);
  err.status = status;
  return err;
}

// 400/422/502 from RIMPL are deterministic (malformed request / validation / un-parseable or
// out-of-range model output). A 401/403 is an INTERNAL_TOKEN misconfig — also not self-healing.
const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 422, 502]);
function isDeterministicRimplError(err) {
  return err && typeof err.status === 'number' && DETERMINISTIC_STATUSES.has(err.status);
}

// `patient_ref` (the physician's structured patient identifier) is forwarded to RIMPL on-prem SOLELY
// so RIMPL can scrub it from the narrative/transcript before any cloud call — it is never forwarded
// to the cloud AI. See docs/constraints.md (data boundary).
async function rimplChat({ cle_id, history, message, language, chief_complaint, patient_ref, socratic, artifacts }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ cle_id, history, message, language, chief_complaint, patient_ref, socratic: !!socratic, artifacts: !!artifacts }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/chat', res.status);
  return res.json();
}

// Auditor calibration chat: discuss a CLE's AI evaluation vs the auditor's own scores. The transcript
// is sent so RIMPL can de-identify it on-prem before the cloud call (stored raw); patient_ref gives
// the scrub hints. Metered against the auditor's SEPARATE budget pool by the caller.
async function rimplAuditDiscuss({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref }) {
  const res = await fetch(`${RIMPL_URL}/audit-discuss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/audit-discuss', res.status);
  return res.json();
}

async function rimplEvaluate({ cle_id, transcript, patient_ref }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ cle_id, transcript, patient_ref }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/evaluate', res.status);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript, patient_ref }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript, patient_ref }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/evaluate-criteria', res.status);
  return res.json();
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

module.exports = { rimplChat, rimplAuditDiscuss, rimplEvaluate, rimplEvaluateCriteria, isDeterministicRimplError, RIMPL_URL, probeRimplDeep };
