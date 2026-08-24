// Local (on-premise) provider — an OpenAI-compatible chat-completions transport, for the model
// served on the CLICS DGX over the Tailscale network. See docs/LOCAL-MODEL-ROADMAP.md.
//
// WHY OpenAI-compatible and not the Anthropic shape: every mainstream self-hosted serving stack
// (vLLM, SGLang, Ollama, Open WebUI) exposes /v1/chat/completions. This module's whole job is to
// make that endpoint indistinguishable from the Anthropic relay to the four RIMPL routes.
//
// PII: nothing here de-identifies anything. The boundary sits UPSTREAM in the routes
// (services/pii-filter.js + lib/transcript.js) and must stay there — a provider is a transport.
//
// TRANSPORT SECURITY: plain http:// is acceptable ONLY across the tailnet, which is WireGuard-
// encrypted end to end. Never point LOCAL_AI_BASE_URL at a plaintext public address.
const { createRunner } = require('./runtime');

// Config is read LAZILY (first call), not at module load: this module is required unconditionally by
// services/ai.js, and must not throw or capture stale env when the local provider is not in use.
// Math.max(1, parseInt('auto', 10)) is NaN, not 1 — Math.max PROPAGATES NaN. A NaN ceiling makes
// runtime.js's `active < maxConcurrency` permanently false, so every call is queued and nothing ever
// runs or releases: a silent, permanent hang with no error and no log. Parse defensively so a bad or
// placeholder env value falls back to the documented default instead.
function intEnv(name, dflt, min = 0) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

const cfg = () => ({
  baseUrl: String(process.env.LOCAL_AI_BASE_URL || '').replace(/\/+$/, ''),
  model: String(process.env.LOCAL_AI_MODEL || ''),
  apiKey: process.env.LOCAL_AI_API_KEY || '',
  // Match the Anthropic ceiling (85s) so backend's RIMPL_EVAL_TIMEOUT_MS (100s) still bounds us.
  timeoutMs: intEnv('LOCAL_AI_TIMEOUT_MS', 85000, 1000),
});

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN']);

function isRetryable(err) {
  // OUR OWN client-side deadline is terminal, never retryable. AbortSignal.timeout rejects with a
  // DOMException{name:'TimeoutError', message:'The operation was aborted due to timeout'} carrying
  // no .status and a NUMERIC .code (23), so it would otherwise fall through to the regex below,
  // match /timeout|aborted/, and re-run the FULL generation: 4 x 85s = 340s against a backend that
  // aborts the request at RIMPL_EVAL_TIMEOUT_MS = 100s. Every retry would be dead work on a caller
  // that has already hung up, while still occupying a queue slot other requests are waiting for.
  if (err && err.localTimeout) return false;
  if (err && typeof err.status === 'number' && RETRYABLE_STATUS.has(err.status)) return true;
  const code = err?.code || err?.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /timeout|aborted|terminated|fetch failed|network|overloaded/i.test(err?.message || '');
}
function retryAfterMs(err) {
  const raw = err?.headers?.get ? err.headers.get('retry-after') : null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 30000) : null;
}

// A dedicated GPU box has no per-account quota, but it is NOT unbounded — throughput is capped by
// VRAM and the server's batch scheduler. Keep a limiter; size it from a measured burst, not from an
// assurance that "concurrency is not a problem".
let runner = null;
function getRunner() {
  if (!runner) {
    const maxConcurrency = intEnv('LOCAL_MAX_CONCURRENCY', 24, 1);
    const maxRetries = intEnv('LOCAL_MAX_RETRIES', 3, 0);
    const retryBaseMs = intEnv('LOCAL_RETRY_BASE_MS', 500, 1);
    runner = createRunner({
      name: 'local',
      maxConcurrency,
      maxRetries,
      retryBaseMs,
      isRetryable,
      retryAfterMs,
      onRetry: (err, attempt) => {
        const { active, queued } = runner.stats();
        // No anthropic-ratelimit-* headers exist here, so queue depth is the only saturation signal.
        console.warn(`[local-ai] retryable error (status ${err?.status ?? '?'}: ${err?.message ?? ''}), attempt ${attempt + 1}/${maxRetries} — in-flight:${active} queued:${queued}`);
      },
    });
  }
  return runner;
}

async function httpJson(url, { method = 'GET', body, timeoutMs, apiKey }) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Tag OUR deadline so isRetryable can tell it apart from a transient network blip (which IS
    // worth retrying). A server-side timeout arrives as an HTTP status instead and stays retryable.
    if (e?.name === 'TimeoutError') e.localTimeout = true;
    throw e;
  }
  if (!res.ok) {
    // Attach .status (and the headers) so isRetryable/retryAfterMs behave exactly as they do for the
    // Anthropic SDK's error objects — a 429/503 from vLLM must retry, a 400 must not.
    const detail = await res.text().catch(() => '');
    const err = new Error(`local AI ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    err.headers = res.headers;
    throw err;
  }
  return res.json();
}

// OpenAI `finish_reason` → Anthropic `stop_reason` vocabulary. This mapping is load-bearing:
// routes/evaluate.js branches on 'max_tokens' (genuinely truncated → needs a bigger ceiling) vs
// 'end_turn' (model finished without emitting JSON → a compliance problem a bigger ceiling can't
// fix). Translating here keeps that diagnosis provider-agnostic.
const FINISH_REASON = { length: 'max_tokens', stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'content_filter' };

async function call({ systemPrompt, messages, maxTokens = 1500, temperature }) {
  const { baseUrl, model, apiKey, timeoutMs } = cfg();
  if (!baseUrl) throw new Error('LOCAL_AI_BASE_URL is not set (AI_PROVIDER=local requires it)');
  if (!model) throw new Error('LOCAL_AI_MODEL is not set (AI_PROVIDER=local requires it)');

  return getRunner().run(async () => {
    // Anthropic takes `system` as a top-level parameter; OpenAI-compatible servers take it as the
    // first message of the conversation.
    const body = {
      model,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
      max_tokens: maxTokens,
      stream: false,
    };
    if (temperature != null) body.temperature = temperature;

    const data = await httpJson(`${baseUrl}/chat/completions`, { method: 'POST', body, timeoutMs, apiKey });

    const choice = data.choices?.[0];
    // Accept ONLY a string content. A server that returns structured/reasoning content (content:null
    // plus reasoning_content) must degrade to '' rather than leak chain-of-thought into a clinical
    // transcript — the caller surfaces the failure via stopReason instead.
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const rawFinish = choice?.finish_reason ?? null;

    return {
      text,
      inputTokens,
      outputTokens,
      tokenCount: inputTokens + outputTokens,
      stopReason: rawFinish ? (FINISH_REASON[rawFinish] ?? rawFinish) : null,
      // The model the SERVER reports, falling back to the one we asked for. Recorded per evaluation
      // for §10.2 provenance — a box whose model changed underneath us must show up in the data.
      model: data.model || model,
    };
  });
}

// Readiness for /health/deep: GET /models. Cheap, no generation, zero cost. Never throws.
async function ready() {
  const { baseUrl, model, apiKey } = cfg();
  const probeMs = Math.max(200, parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || '2000', 10));
  if (!baseUrl || !model) {
    return { checks: { local_ai: { status: 'down', error: !baseUrl ? 'LOCAL_AI_BASE_URL not set' : 'LOCAL_AI_MODEL not set' } } };
  }
  try {
    const data = await httpJson(`${baseUrl}/models`, { timeoutMs: probeMs, apiKey });
    const served = (data?.data || []).map((m) => m.id);
    // An unenumerable /models proves NOTHING, so it cannot count as healthy: a reverse proxy or a
    // vLLM instance still registering answers 200 with {} or {"data":[]}, and treating that as `up`
    // green-lights precisely the failure this probe exists to catch — every /chat/completions 404s.
    if (!served.length) {
      return { checks: { local_ai: { status: 'down', error: '/models returned 200 but enumerated no models' } } };
    }
    // Reachable but NOT serving the pinned model is a real misconfiguration, not a warning: every
    // call would 404, and a silently-renamed model breaks the locked-version provenance guarantee.
    if (!served.includes(model)) {
      return { checks: { local_ai: { status: 'down', error: `model "${model}" not served (available: ${served.slice(0, 5).join(', ')})` } } };
    }
    return { checks: { local_ai: { status: 'up', model } } };
  } catch (e) {
    return { checks: { local_ai: { status: 'down', error: e.message } } };
  }
}

module.exports = { name: 'local', call, model: () => cfg().model, ready, stats: () => getRunner().stats() };
