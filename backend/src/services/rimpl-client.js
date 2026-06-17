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

async function rimplChat({ cle_id, history, message, language, chief_complaint, socratic }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ cle_id, history, message, language, chief_complaint, socratic: !!socratic }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/chat', res.status);
  return res.json();
}

async function rimplEvaluate({ cle_id, transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ cle_id, transcript }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/evaluate', res.status);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw rimplError('/evaluate-criteria', res.status);
  return res.json();
}

module.exports = { rimplChat, rimplEvaluate, rimplEvaluateCriteria, isDeterministicRimplError };
