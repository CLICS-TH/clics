// rimpl/src/services/claude.js
const Anthropic = require('@anthropic-ai/sdk');

// We do our own retry (below), so disable the SDK's internal retry to avoid double-retrying.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 55000, maxRetries: 0 });
const MODEL = 'claude-sonnet-4-6';

// --- Concurrency limiter (the "queue") --------------------------------------------------------
// A burst of simultaneous chats used to fail (~33% success at 40 concurrent) because they all hit
// the Anthropic API at once and tripped its rate limit. Cap the number of IN-FLIGHT Claude calls;
// excess calls wait in a FIFO queue instead of failing, smoothing the burst under the rate limit.
// Tunable via CLAUDE_MAX_CONCURRENCY (default 10 — safely under the observed per-account ceiling).
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CLAUDE_MAX_CONCURRENCY || '12', 10));
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENCY) { active++; return Promise.resolve(); }
  return new Promise(resolve => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next();      // hand the slot straight to the next waiter (active unchanged)
  else active--;
}

// --- Retry with exponential backoff + jitter --------------------------------------------------
const MAX_RETRIES = Math.max(0, parseInt(process.env.CLAUDE_MAX_RETRIES || '5', 10));
const RETRY_BASE_MS = Math.max(1, parseInt(process.env.CLAUDE_RETRY_BASE_MS || '800', 10));
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]); // rate-limit / overload / transient
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
function backoffMs(attempt, err) {
  const ra = retryAfterMs(err);
  if (ra != null) return ra; // honor the server's Retry-After when present
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, 20000);
  return base + Math.floor(Math.random() * 400); // jitter to de-sync concurrent retries
}

// Observability: surface which Anthropic rate-limit dimension binds (RPM vs ITPM vs OTPM vs concurrent)
// so CLAUDE_MAX_CONCURRENCY / the account tier can be tuned with data instead of guesses.
let tierLogged = false;
function logRateLimit(headers, where) {
  if (!headers) return;
  const get = k => (headers.get ? headers.get(k) : headers[k]);
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

async function callClaude({ systemPrompt, messages, maxTokens = 1500 }) {
  await acquire(); // queue if we're already at max in-flight
  try {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // .withResponse() yields the same Message as `data` PLUS the HTTP response, so we can read
        // the anthropic-ratelimit-* headers to learn the binding dimension.
        const { data, response: httpResp } = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages }).withResponse();
        logRateLimit(httpResp?.headers, 'ok');
        // Join ALL text blocks, not just content[0]: a reply led by a non-text block (thinking/tool)
        // would otherwise silently become '' and degrade the chat (blank reply) or the eval (composite 0).
        // Select by .text presence so thinking/tool_use blocks (no .text) drop out.
        const text = (data.content || []).filter(b => typeof b.text === 'string').map(b => b.text).join('');
        const inputTokens = data.usage?.input_tokens ?? 0;
        const outputTokens = data.usage?.output_tokens ?? 0;
        // tokenCount (summed) is kept for the C3 CLE gate; input/output are split out for cost.
        return { text, inputTokens, outputTokens, tokenCount: inputTokens + outputTokens };
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const ra = retryAfterMs(err);
          console.warn(`[claude] retryable error (status ${err?.status ?? '?'}${ra != null ? `, retry-after ${Math.round(ra / 1000)}s` : ''}), attempt ${attempt + 1}/${MAX_RETRIES} — backing off`);
          logRateLimit(err?.headers, '429');
          await sleep(backoffMs(attempt, err)); // slot stays held during backoff → naturally eases pressure
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

module.exports = { callClaude };
