// Anthropic (cloud) provider. This is the original RIMPL relay, moved behind the provider interface
// in services/ai.js — the transport, the retry policy and the concurrency queue are unchanged.
//
// NOTE (CLICS §9.5, Appendix 17 / no-training): Anthropic's commercial API does NOT train on API
// inputs/outputs by default — there is no per-request "no-training" header to set here. The
// protocol's no-training + retention guarantee is satisfied by the ORG-LEVEL DPA / zero-data-
// retention (ZDR) arrangement on the Anthropic account, not by code. Track that in GO-LIVE-CHECKLIST.
const Anthropic = require('@anthropic-ai/sdk');
const { createRunner } = require('./runtime');
const { ANTHROPIC_MODEL } = require('../../lib/provider-policy');

// We do our own retry (via the shared runner), so disable the SDK's internal retry to avoid
// double-retrying.
// 150000, not 85000 (and originally 55000): a 130k-token eval transcript (PLE-052, 2026-08-17)
// needed >55s just to generate the JSON scoring response (7 domains + quote-grounded rationale,
// after the maxTokens bump in routes/evaluate.js), so the SDK's own 55s ceiling fired mid-generation
// (APIConnectionTimeoutError) before the model ever finished. 85s then fixed that but left no room
// for the on-prem provider, whose measured evaluations ran 82.5s and 87.8s — one already over. Both
// providers share a 150s ceiling, under the backend's outer RIMPL_EVAL_TIMEOUT_MS (480s since the
// evaluation drain; it was 180s when this ceiling was set), so a slow evaluation is slow rather than
// lost. Tunable for the same reason the local one is.
//
// WHAT A TIMEOUT DOES. The SDK throws APIConnectionTimeoutError ("Request timed out."), which
// isRetryable() below does NOT match (no status, no network code, and "timed out" is not "timeout").
// So a timed-out call is ONE attempt and then an error (a 500 from the route), not a retry. Other
// retryable errors on an evaluation stop being retried once a further attempt could no longer finish
// inside the backend's deadline (EVAL_LATE_RETRY_MS below).
const CLIENT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLAUDE_TIMEOUT_MS || '150000', 10));

// LATE-RETRY CUTOFF for evaluations. The backend gives /evaluate RIMPL_EVAL_TIMEOUT_MS in all
// (backend/src/services/rimpl-client.js, default 480s; this mirrors that default, it does not read it).
// A retry that STARTS later than (that deadline − one full attempt − slack) cannot finish before the
// backend hangs up. The caller's abort signal (call() below) would cancel it then, but the tokens it
// generated meanwhile are billed, and the drain re-claims the row and pays again. So an evaluation
// error arriving after the cutoff fails now, and the drain's own backoff takes over. The slack covers
// the backoff sleep (up to 30s with a Retry-After). Derived, not hardcoded: raise CLAUDE_TIMEOUT_MS and
// the cutoff moves with it.
//
// FLOORED at 60s. Without a floor, a CLAUDE_TIMEOUT_MS near the deadline would drive the cutoff to 0
// and silently turn off every evaluation retry, including the cheap, early 429/529 retries that cost a
// few seconds and are what the retry policy exists for. A misconfiguration should be loud, not
// absorbed, hence the boot warning below.
//
// EVAL_CALLER_DEADLINE_MS mirrors backend/src/services/rimpl-client.js RIMPL_EVAL_TIMEOUT_MS (480s). It
// cannot read it across the service boundary, so CHANGE BOTH TOGETHER.
const EVAL_CALLER_DEADLINE_MS = 480000;
const EVAL_LATE_RETRY_SLACK_MS = 30000;
const EVAL_LATE_RETRY_FLOOR_MS = 60000;
const EVAL_LATE_RETRY_MS = Math.max(EVAL_LATE_RETRY_FLOOR_MS, EVAL_CALLER_DEADLINE_MS - CLIENT_TIMEOUT_MS - EVAL_LATE_RETRY_SLACK_MS); // 300s by default
if (CLIENT_TIMEOUT_MS + EVAL_LATE_RETRY_SLACK_MS >= EVAL_CALLER_DEADLINE_MS) {
  console.warn(`[claude] CLAUDE_TIMEOUT_MS=${CLIENT_TIMEOUT_MS} plus ${EVAL_LATE_RETRY_SLACK_MS}ms slack reaches the backend's ${EVAL_CALLER_DEADLINE_MS}ms /evaluate deadline: a single slow evaluation can outlive its caller. The late-retry cutoff is held at its ${EVAL_LATE_RETRY_FLOOR_MS}ms floor. Lower CLAUDE_TIMEOUT_MS, or raise RIMPL_EVAL_TIMEOUT_MS (backend) and EVAL_CALLER_DEADLINE_MS here together.`);
}
// Only the SERVED evaluation has a caller deadline. The shadow evaluation (services/shadow.js) runs in
// the background after the response has been sent, so nobody is waiting on it and it keeps every retry.
const EVAL_PURPOSES = new Set(['evaluate']);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: CLIENT_TIMEOUT_MS, maxRetries: 0 });
// PINNED, not an alias: lib/provider-policy.js ANTHROPIC_MODEL, with the reason it is pinned. It lives
// there, package-free, so the model manifest (lib/manifest.js) and the probe/quality harnesses read the id
// this file sends without loading the SDK. No model id is written in this file, not even in a comment: the
// probes once regex-scraped the first one they found here. Never swap it for a moving alias (a "-latest"
// name): CREC082 §10.2 requires the model behind every score to be fixed and recorded.
const MODEL = ANTHROPIC_MODEL;

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

// CLASSIFICATION only: is this the kind of error a retry could fix? Recorded as lastError.retryable, so
// it must stay truthful. Whether THIS call retries is shouldRetry() below.
function isRetryable(err) {
  if (err && typeof err.status === 'number' && RETRYABLE_STATUS.has(err.status)) return true;
  const code = err?.code || err?.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /timeout|aborted|terminated|fetch failed|network|overloaded/i.test(err?.message || '');
}
// The retry DECISION: a retryable error, unless call() marked it `noRetry` (a late /evaluate error that a
// further attempt could not finish before the caller's deadline; EVAL_LATE_RETRY_MS).
function shouldRetry(err) {
  return err?.noRetry !== true && isRetryable(err);
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
  shouldRetry,
  retryAfterMs,
  onRetry: (err, attempt, ra) => {
    console.warn(`[claude] retryable error (status ${err?.status ?? '?'}${ra != null ? `, retry-after ${Math.round(ra / 1000)}s` : ''}), attempt ${attempt + 1}/${MAX_RETRIES} — backing off`);
    logRateLimit(err?.headers, '429');
  },
});

// `onDelta(text)` (optional) streams the reply: each text piece is handed over as it arrives, and the
// call still resolves with the same whole-reply result. Once a piece has gone out the attempt can no
// longer be retried — the caller has already shown it — so an error after that point is terminal.
async function call({ systemPrompt, messages, maxTokens = 1500, temperature, purpose, signal, onDelta }) {
  const startedAt = Date.now();
  const isEval = EVAL_PURPOSES.has(purpose);
  // `signal` is the caller's client-gone signal (lib/request-signal.js). Passed to the runner, a call
  // still QUEUED when the backend hangs up never starts (runtime.js re-checks it when the slot frees);
  // passed to the SDK, an in-flight call is cancelled at the socket (APIUserAbortError), and the runner
  // turns that into an AbortError that is never retried. Without it, a hung-up call ran to completion,
  // billed and unmetered, and for an evaluation the drain then re-claimed the row and paid again.
  return runner.run(async (_attempt, sig) => {
    // .withResponse() yields the same Message as `data` PLUS the HTTP response, so we can read
    // the anthropic-ratelimit-* headers to learn the binding dimension.
    // When caching is on, the system prompt is sent as a cacheable text block (array form).
    const system = PROMPT_CACHE
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;
    const body = { model: MODEL, max_tokens: maxTokens, system, messages };
    if (temperature != null) body.temperature = temperature;
    let data, httpResp;
    let emitted = false;
    try {
      if (onDelta) {
        const stream = client.messages.stream(body, { signal: sig });
        stream.on('text', (t) => { if (t) { emitted = true; onDelta(t); } });
        data = await stream.finalMessage();
        // SDK 0.30's MessageStream exposes no HTTP response, so a streamed call skips the
        // rate-limit header log below (logRateLimit tolerates undefined).
      } else {
        ({ data, response: httpResp } = await client.messages.create(body, { signal: sig }).withResponse());
      }
    } catch (err) {
      if (emitted && err && typeof err === 'object') err.noRetry = true;
      const elapsed = Date.now() - startedAt;
      if (isEval && elapsed > EVAL_LATE_RETRY_MS && err && typeof err === 'object' && !sig?.aborted) {
        err.noRetry = true;
        console.warn(`[claude] not retrying a late /evaluate error (status ${err.status ?? '?'}, ${Math.round(elapsed / 1000)}s elapsed > ${Math.round(EVAL_LATE_RETRY_MS / 1000)}s cutoff): a further attempt could not finish inside the backend's ${EVAL_CALLER_DEADLINE_MS / 1000}s /evaluate deadline`);
      }
      throw err;
    }
    logRateLimit(httpResp?.headers, 'ok');
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
    return { text, inputTokens, outputTokens, tokenCount: inputTokens + outputTokens, stopReason: data.stop_reason, model };
  }, { signal });
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

module.exports = { name: 'anthropic', call, model: () => MODEL, ready, stats: runner.stats, MODEL, EVAL_LATE_RETRY_MS, isRetryable, shouldRetry };
