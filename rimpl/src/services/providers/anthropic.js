// Anthropic (cloud) provider. This is the original RIMPL relay, moved behind the provider interface
// in services/ai.js — the transport, the retry policy and the concurrency queue are unchanged.
//
// NOTE (CLICS §9.5, Appendix 17 / no-training): Anthropic's commercial API does NOT train on API
// inputs/outputs by default — there is no per-request "no-training" header to set here. The
// protocol's no-training + retention guarantee is satisfied by the ORG-LEVEL DPA / zero-data-
// retention (ZDR) arrangement on the Anthropic account, not by code. Track that in GO-LIVE-CHECKLIST.
const Anthropic = require('@anthropic-ai/sdk');
const { createRunner } = require('./runtime');

// We do our own retry (via the shared runner), so disable the SDK's internal retry to avoid
// double-retrying.
// 150000, not 85000 (and originally 55000): a 130k-token eval transcript (PLE-052, 2026-08-17)
// needed >55s just to generate the JSON scoring response (7 domains + quote-grounded rationale,
// after the maxTokens bump in routes/evaluate.js), so the SDK's own 55s ceiling fired mid-generation
// (APIConnectionTimeoutError) before the model ever finished. 85s then fixed that but left no room
// for the on-prem provider, whose measured evaluations ran 82.5s and 87.8s — one already over. Both
// providers now share a 150s ceiling under backend's outer RIMPL_EVAL_TIMEOUT_MS (180s), so a slow
// evaluation is slow rather than lost. Tunable for the same reason the local one is.
const CLIENT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLAUDE_TIMEOUT_MS || '150000', 10));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: CLIENT_TIMEOUT_MS, maxRetries: 0 });
const MODEL = 'claude-sonnet-4-6';

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

async function call({ systemPrompt, messages, maxTokens = 1500, temperature }) {
  return runner.run(async () => {
    // .withResponse() yields the same Message as `data` PLUS the HTTP response, so we can read
    // the anthropic-ratelimit-* headers to learn the binding dimension.
    // When caching is on, the system prompt is sent as a cacheable text block (array form).
    const system = PROMPT_CACHE
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;
    const body = { model: MODEL, max_tokens: maxTokens, system, messages };
    if (temperature != null) body.temperature = temperature;
    const { data, response: httpResp } = await client.messages.create(body).withResponse();
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
    return { text, inputTokens, outputTokens, tokenCount: inputTokens + outputTokens, stopReason: data.stop_reason, model: MODEL };
  });
}

// Readiness probe for /health/deep: confirm the API key is present and the SDK client is
// constructible — WITHOUT making a completion call (zero token spend). Never throws.
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
    },
  };
}

module.exports = { name: 'anthropic', call, model: () => MODEL, ready, stats: runner.stats, MODEL };
