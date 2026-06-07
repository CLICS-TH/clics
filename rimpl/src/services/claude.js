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
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CLAUDE_MAX_CONCURRENCY || '10', 10));
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

async function callClaude({ systemPrompt, messages, maxTokens = 1500 }) {
  await acquire(); // queue if we're already at max in-flight
  try {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages });
        const text = response.content[0]?.text ?? '';
        const inputTokens = response.usage?.input_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;
        return { text, tokenCount: inputTokens + outputTokens };
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          console.warn(`[claude] retryable error (status ${err?.status ?? '?'}), attempt ${attempt + 1}/${MAX_RETRIES} — backing off`);
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
