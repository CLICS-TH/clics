const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';
// A chat may make up to 2 Claude calls (initial + citation retry) AND wait in RIMPL's concurrency
// queue under load, so the wrapper timeout must cover queue-wait + generation. Env-tunable; raised
// from 75s -> 100s to recover burst-tail calls that previously aborted while queued.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
// Evaluation timeout must cover RIMPL's concurrency-queue wait + one Claude attempt (55s SDK
// timeout) + retries — the old hard-coded 30s aborted burst-tail evals (end-of-cohort) while they
// were still queued, mis-routing sessions to manual QA / stranding credit. Default to the chat value.
const EVAL_TIMEOUT_MS = parseInt(process.env.RIMPL_EVAL_TIMEOUT_MS || `${CHAT_TIMEOUT_MS}`, 10);

async function rimplChat({ ple_id, history, message, language, chief_complaint }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ ple_id, history, message, language, chief_complaint }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RIMPL /chat error: ${res.status}`);
  return res.json();
}

async function rimplEvaluate({ ple_id, transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ ple_id, transcript }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate error: ${res.status}`);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate-criteria error: ${res.status}`);
  return res.json();
}

module.exports = { rimplChat, rimplEvaluate, rimplEvaluateCriteria };
