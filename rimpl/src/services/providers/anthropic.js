// Anthropic (cloud) provider. This is the original RIMPL relay, moved behind the provider interface
// in services/ai.js — the transport, the retry policy and the concurrency queue are unchanged.
//
// NOTE (CLICS §9.5, Appendix 17 / no-training): Anthropic's commercial API does NOT train on API
// inputs/outputs by default — there is no per-request "no-training" header to set here. The
// protocol's no-training + retention guarantee is satisfied by the ORG-LEVEL DPA / zero-data-
// retention (ZDR) arrangement on the Anthropic account, not by code. Track that in GO-LIVE-CHECKLIST.
const Anthropic = require('@anthropic-ai/sdk');
const { createRunner } = require('./runtime');
const { requestShape } = require('../../lib/anthropic-request');

// We do our own retry (via the shared runner), so disable the SDK's internal retry to avoid
// double-retrying.
//
// The CLIENT TIMEOUT, per purpose. History: 55s fired mid-generation on PLE-052 (a ~130k-token eval
// transcript, 2026-08-17); 85s left no room for the on-prem provider's ~83-88s evaluations; 150s held
// until claude-sonnet-5-5.
//
// 300000 for EVALUATIONS since claude-sonnet-5-5 (2026-10-03). The evaluator now runs adaptive thinking
// at effort high with max_tokens 16000 (lib/eval-decoding.js), so one call may generate up to 16000
// tokens of thinking plus JSON. The only measured cloud throughput is 4-6's: 1-3.2k output tokens in
// 16.0-65.7s on 5.1k-token inputs (docs/GATE0-DGX-RESULTS.md §7.1), i.e. roughly 50-100 tok/s with
// prefill included. At a conservative 60 tok/s a full 16000-token reply needs ~267s, and the prefill of
// the largest transcript seen (PLE-052) adds seconds, not minutes, so 300s covers the worst single call.
// It must stay UNDER the backend's RIMPL_EVAL_TIMEOUT_MS (480s), leaving 180s for rimpl's queue wait.
// Invert the two and the backend hangs up on a score that was about to arrive.
//
// WHAT A TIMEOUT DOES. The SDK throws APIConnectionTimeoutError ("Request timed out."), which
// isRetryable() below does NOT match (no status, no network code, and "timed out" is not "timeout").
// So a timed-out evaluation is ONE attempt and then an error: a single 500, not a retry. Other
// retryable errors on an evaluation are cut off by the late-retry rule (EVAL_LATE_RETRY_MS) once a
// second attempt could no longer finish inside the backend's deadline.
// Unmeasured on 5.5: the paid repeat-consistency run should record latency before deploy.
const EVAL_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10));
// Chat, criteria and discuss keep 150s. The backend gives each of them 100s (RIMPL_CHAT_TIMEOUT_MS) or
// 180s (criteria at /end). When the backend hangs up first, the caller's signal now aborts the call
// (see call() below), so this ceiling only matters for a caller that is still waiting.
const INTERACTIVE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLAUDE_INTERACTIVE_TIMEOUT_MS || '150000', 10));
const EVAL_PURPOSES = new Set(['evaluate', 'shadow']);
const timeoutFor = (purpose) => (EVAL_PURPOSES.has(purpose) ? EVAL_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS);

// LATE-RETRY CUTOFF for evaluations. The backend gives /evaluate 480s in all
// (backend/src/services/rimpl-client.js RIMPL_EVAL_TIMEOUT_MS; it mirrors that default, it does not read
// it). A retry that STARTS after 480 − 300 − slack seconds cannot finish before the backend hangs up,
// so it would only buy a reply nobody reads. The abort below would cancel it at 480s, but the tokens
// already generated are billed, and the drain then re-claims the row and pays again. So an evaluation
// error that arrives later than this is not retried: it fails now, and the drain's own backoff takes
// over. The slack covers the backoff sleep (up to 30s with a Retry-After) and the prefill.
const EVAL_CALLER_DEADLINE_MS = 480000;
const EVAL_LATE_RETRY_SLACK_MS = 30000;
const EVAL_LATE_RETRY_MS = Math.max(0, EVAL_CALLER_DEADLINE_MS - EVAL_TIMEOUT_MS - EVAL_LATE_RETRY_SLACK_MS); // 150s by default
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: EVAL_TIMEOUT_MS, maxRetries: 0 });
// PINNED, not an alias. From the 4.6 generation on, Anthropic's canonical model ids carry no date:
// GET /v1/models/claude-sonnet-5-5 resolves to itself (display "Claude Sonnet 5.5", created
// 2026-09-28, max_input_tokens 1000000, max_tokens 128000), the same way the older dated ids
// (claude-sonnet-4-5-20250929) do. No dated variant exists: claude-sonnet-5-5-20260928 and
// claude-sonnet-5-5-latest both 404, and the account's /v1/models listing has no other 5.5 entry.
// So the canonical id IS the snapshot. Verified 2026-10-03. Never swap this for a moving alias
// (a "-latest" name): CREC082 §10.2 requires the model behind every score to be fixed and recorded.
//
// Changed from claude-sonnet-4-6 (created 2026-02-17) on 2026-10-03. THAT CHANGES THE INSTRUMENT:
// every ICC / calibration figure measured on 4-6 does not transfer (ICC is a property of model x
// prompt x rubric). See scripts/calibration/prompt-versions.md. The request shape changed with it.
// lib/anthropic-request.js says what this model accepts, and boot fails if it has no entry there.
const MODEL = 'claude-sonnet-5-5';
// Fail at boot, not on the first scored evaluation, if the pin has no declared shape for a purpose rimpl
// sends it. `shadow` is services/shadow.js; the rest are services/ai.js PURPOSES.
for (const purpose of ['evaluate', 'shadow', 'chat', 'criteria', 'discuss']) requestShape(MODEL, { purpose });

// Prompt caching (default OFF). The ~2k-token system prompt is re-sent every turn at full input price;
// caching it cuts that to ~10% after the first call. DEFAULT OFF because zero-data-retention (ZDR)
// accounts may not permit prompt caching — confirm the org DPA allows it, then set RIMPL_PROMPT_CACHE=1.
const PROMPT_CACHE = process.env.RIMPL_PROMPT_CACHE === '1';

// Tunable via CLAUDE_MAX_CONCURRENCY (default 12 — safely under the observed per-account ceiling).
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CLAUDE_MAX_CONCURRENCY || '12', 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.CLAUDE_MAX_RETRIES || '5', 10));
const RETRY_BASE_MS = Math.max(1, parseInt(process.env.CLAUDE_RETRY_BASE_MS || '800', 10));

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]); // rate-limit / overload / transient
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN']);

function isRetryable(err) {
  if (err?.noRetry === true) return false;   // set by call() for a late evaluation error (EVAL_LATE_RETRY_MS)
  if (err && typeof err.status === 'number' && RETRYABLE_STATUS.has(err.status)) return true;
  const code = err?.code || err?.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /timeout|aborted|terminated|fetch failed|network|overloaded/i.test(err?.message || '');
}
function retryAfterMs(err) {
  const h = err?.headers;
  const raw = h?.get ? h.get('retry-after') : h?.['retry-after'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 30000) : null;
}

// Observability: surface which Anthropic rate-limit dimension binds (RPM vs ITPM vs OTPM vs concurrent)
// so CLAUDE_MAX_CONCURRENCY / the account tier can be tuned with data instead of guesses.
let tierLogged = false;
function logRateLimit(headers, where) {
  if (!headers) return;
  const get = (k) => (headers.get ? headers.get(k) : headers[k]);
  const reqRem = get('anthropic-ratelimit-requests-remaining');
  const tokRem = get('anthropic-ratelimit-tokens-remaining');
  const inRem = get('anthropic-ratelimit-input-tokens-remaining');
  const outRem = get('anthropic-ratelimit-output-tokens-remaining');
  if (!tierLogged) { // log the tier (the *-limit values) once at startup
    tierLogged = true;
    console.log(`[claude] rate-limit tier — requests:${get('anthropic-ratelimit-requests-limit')} tokens:${get('anthropic-ratelimit-tokens-limit')} input:${get('anthropic-ratelimit-input-tokens-limit')} output:${get('anthropic-ratelimit-output-tokens-limit')}`);
  }
  const low = (v, t) => v != null && Number(v) <= t; // flag the dimension that's running out
  if (low(reqRem, 5) || low(tokRem, 8000) || low(inRem, 8000) || low(outRem, 4000)) {
    console.warn(`[claude] rate-limit LOW (${where}) — req:${reqRem} tok:${tokRem} in:${inRem} out:${outRem}`);
  }
}

const runner = createRunner({
  name: 'anthropic',
  maxConcurrency: MAX_CONCURRENCY,
  maxRetries: MAX_RETRIES,
  retryBaseMs: RETRY_BASE_MS,
  isRetryable,
  retryAfterMs,
  onRetry: (err, attempt, ra) => {
    console.warn(`[claude] retryable error (status ${err?.status ?? '?'}${ra != null ? `, retry-after ${Math.round(ra / 1000)}s` : ''}), attempt ${attempt + 1}/${MAX_RETRIES} — backing off`);
    logRateLimit(err?.headers, '429');
  },
});

// A safeguard refusal: HTTP 200, `stop_reason: "refusal"`, `stop_details.category` naming why. It is
// NOT retryable (the same request would be declined again, and each attempt is billed) and it is not
// a provider failure (the provider served the request). The error carries the category and the billed
// usage, numbers and a fixed-vocabulary word only, never the content, so callers can meter it and
// sendAiError (lib/ai-errors.js) can answer with a distinct code. NEVER answered by a `fallbacks`
// re-run: a different model producing a score is exactly what §10.2 forbids.
class RefusalError extends Error {
  constructor({ category, inputTokens, outputTokens, model }) {
    super(`model declined the request (refusal${category ? `, category ${category}` : ''})`);
    this.name = 'RefusalError';
    this.code = 'refused';
    this.category = category;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.model = model;
    // Same shape as the usage the rescue path already reads off a failed classifier call
    // (routes/chat.js), so a refused assessment is still charged to the study.
    this.usage = { inputTokens, outputTokens, provider: 'anthropic' };
  }
}
// Anthropic documents the category set as open. Only a short lowercase word passes, so nothing else the
// response might carry can ride into a log line or an error body.
const safeCategory = (c) => (typeof c === 'string' && /^[a-z_]{1,40}$/.test(c) ? c : null);

async function call({ systemPrompt, messages, maxTokens = 1500, temperature, purpose, signal }) {
  // The model-specific fields (thinking mode and effort for this purpose; sampling only where the model
  // accepts it) come from lib/anthropic-request.js, the same rule the offline probes use. On
  // claude-sonnet-5-5 a requested temperature is NOT sent: a non-default value is a 400 there, which on
  // the scored path would be a 502 on every evaluation. `sent` below records what actually went out, so
  // provenance says so. Resolved BEFORE the queue: an undeclared purpose is a programming error and
  // must not take a slot or register as a provider failure.
  const shape = requestShape(MODEL, { temperature, purpose });
  if (shape.dropped.length) warnDroppedOnce(shape.dropped);
  const startedAt = Date.now();
  const isEval = EVAL_PURPOSES.has(purpose);
  // `signal` is the caller's client-gone signal (lib/request-signal.js). Passed to the runner, a call
  // still QUEUED when the backend hangs up never starts; passed to the SDK, an in-flight one is cancelled
  // at the socket (APIUserAbortError), and the runner turns that into an AbortError that is never retried.
  // Without it, a hung-up evaluation ran to completion, billed unmetered, and the drain then paid again.
  const data = await runner.run(async (_attempt, sig) => {
    // .withResponse() yields the same Message as `data` PLUS the HTTP response, so we can read
    // the anthropic-ratelimit-* headers to learn the binding dimension.
    // When caching is on, the system prompt is sent as a cacheable text block (array form).
    const system = PROMPT_CACHE
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;
    const body = { model: MODEL, max_tokens: maxTokens, system, messages, ...shape.fields };
    try {
      const { data: msg, response: httpResp } = await client.messages.create(body, { timeout: timeoutFor(purpose), signal: sig }).withResponse();
      logRateLimit(httpResp?.headers, 'ok');
      return msg;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (isEval && elapsed > EVAL_LATE_RETRY_MS && err && typeof err === 'object' && !sig?.aborted) {
        err.noRetry = true;
        console.warn(`[claude] not retrying a late evaluation error (status ${err.status ?? '?'}, ${Math.round(elapsed / 1000)}s elapsed > ${Math.round(EVAL_LATE_RETRY_MS / 1000)}s): a second attempt could not finish inside the caller's ${EVAL_CALLER_DEADLINE_MS / 1000}s`);
      }
      throw err;
    }
  }, { signal });
  // Outside the runner on purpose: the request was SERVED, so the runner records a success and
  // /health/deep stays green. A refusal says something about this request, not about the account.
  if (data.stop_reason === 'refusal') {
    const category = safeCategory(data.stop_details?.category);
    const model = typeof data.model === 'string' && data.model ? data.model : MODEL;
    console.warn(`[claude] refusal (purpose ${purpose ?? '?'}, category ${category ?? 'none'})`); // the category only, never content
    throw new RefusalError({
      category, model,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    });
  }
  // Join ALL text blocks, not just content[0]: a reply led by a non-text block (thinking/tool)
  // would otherwise silently become '' and degrade the chat (blank reply) or the eval (composite 0).
  // Select by .text presence so thinking/tool_use blocks (no .text) drop out.
  const text = (data.content || []).filter((b) => typeof b.text === 'string').map((b) => b.text).join('');
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  // tokenCount (summed) is kept for the C3 PLE gate; input/output are split out for cost.
  // stopReason distinguishes "hit max_tokens" (a real length/truncation problem) from
  // "end_turn" (the model finished on its own without ever producing the expected JSON) —
  // callers that fail to parse `text` need this to tell those two very different causes apart.
  // §10.2 provenance names the model the API SAYS answered, not the one we asked for. Today they are
  // the same id; if they ever differ, the record must show the real one. MODEL only if none came back.
  const model = typeof data.model === 'string' && data.model ? data.model : MODEL;
  // `decoding` is what this call SENT (temperature null when the model refuses sampling; the thinking
  // mode; the effort). routes/evaluate.js records it as §10.2 provenance instead of restating what it
  // asked for.
  return { text, inputTokens, outputTokens, tokenCount: inputTokens + outputTokens, stopReason: data.stop_reason, model, decoding: shape.sent };
}

// Once per process per parameter: enough for an operator to see why provenance reads temperature
// null, without a line on every evaluation.
const warnedDropped = new Set();
function warnDroppedOnce(names) {
  for (const n of names) {
    if (warnedDropped.has(n)) continue;
    warnedDropped.add(n);
    console.warn(`[claude] ${n} requested but not sent: ${MODEL} rejects non-default sampling parameters (recorded as null in provenance)`);
  }
}

// A key that is present and constructible can still be unable to serve a single request: an
// exhausted balance answers 400 forever, a revoked key answers 401. Both used to read `ok`.
//
// Deliberately NARROW. `isRetryable` is the wrong predicate here — it would also catch a 400 caused
// by one malformed request (a prompt over the context limit, say), and one bad request must not
// declare the provider dead. Only conditions that belong to the CREDENTIAL or the ACCOUNT count:
// 401/403 outright, and 400 only when the body says the problem is money. A 429 is a rate limit,
// is retryable, and never lands here.
function cannotServe(err) {
  if (!err) return null;
  if (err.status === 401) return 'API key rejected (401)';
  if (err.status === 403) return 'API key forbidden (403)';
  if (err.status === 402) return 'payment required (402)';
  if (err.status === 400 && /credit balance|billing|quota|insufficient funds/i.test(err.message || '')) {
    return 'account cannot pay for requests (400)';
  }
  return null;
}

// Readiness probe for /health/deep: confirm the API key is present, the SDK client is constructible,
// and — from what the runner last OBSERVED, so still without spending a token — that the account is
// not in a state where every call fails. Never throws.
function ready() {
  const keyPresent = !!process.env.ANTHROPIC_API_KEY;
  let constructible = false;
  try {
    new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); // constructor only — no network
    constructible = true;
  } catch {
    constructible = false;
  }
  return {
    checks: {
      anthropic_key: keyPresent
        ? { status: 'up' }
        : { status: 'down', error: 'ANTHROPIC_API_KEY not set' },
      anthropic_client: constructible
        ? { status: 'up' }
        : { status: 'down', error: keyPresent ? 'Anthropic client not constructible' : 'ANTHROPIC_API_KEY not set' },
      anthropic_serving: servingCheck(),
    },
  };
}

// A recorded failure only means the provider is down while it is still the LAST thing that happened;
// the runner clears it on the next success, so an operator who fixes the key sees green on the next
// call rather than having to restart the process.
function servingCheck() {
  const { lastError } = runner.stats();
  const reason = cannotServe(lastError);
  if (!reason) return { status: 'up' };
  return {
    status: 'down',
    error: `${reason} — ${lastError.message}`,
    observed_at: new Date(lastError.at).toISOString(),
  };
}

module.exports = { name: 'anthropic', call, model: () => MODEL, ready, stats: runner.stats, MODEL, RefusalError, EVAL_LATE_RETRY_MS };
