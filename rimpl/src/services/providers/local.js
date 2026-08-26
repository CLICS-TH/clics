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
  // 150s, not the original 85s. 85s was chosen to match the Anthropic SDK ceiling, but two measured
  // evaluations on the DGX took 82.5s and 87.8s — one of them already over. A ceiling that sits at
  // the middle of the observed distribution turns a slow-but-correct evaluation into a failed one.
  // Must stay UNDER backend's RIMPL_EVAL_TIMEOUT_MS (now 180s) or the outer caller hangs up first
  // and every retry is dead work; see services/rimpl-client.js.
  timeoutMs: intEnv('LOCAL_AI_TIMEOUT_MS', 150000, 1000),
  // The model that serves /embeddings. Usually NOT the chat model — embedding models are separate
  // checkpoints (nomic-embed-text, bge-m3, …) even on the same box.
  embedModel: String(process.env.LOCAL_AI_EMBED_MODEL || ''),
  // A creditable CLE needs C3 ≥ 10,000 tokens, and the evaluator sends the whole transcript. Anything
  // near Ollama's 4096 default cannot score one. Reported by ready() so the mismatch is visible in
  // /health/deep rather than discovered by a physician losing an evaluation.
  minContext: intEnv('LOCAL_AI_MIN_CONTEXT', 16384, 1024),
  // OPT-IN passthrough. The authoritative fix for context length is server-side (the Modelfile /
  // launch flag); servers that accept an `options` bag will honour this, and those that ignore
  // unknown body fields are unaffected. Left unset by default so we never send a field a stricter
  // server would reject.
  numCtx: intEnv('LOCAL_AI_NUM_CTX', 0, 0),
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
  const { baseUrl, model, apiKey, timeoutMs, numCtx } = cfg();
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
    if (numCtx > 0) body.options = { ...(body.options || {}), num_ctx: numCtx };

    let data;
    try {
      data = await httpJson(`${baseUrl}/chat/completions`, { method: 'POST', body, timeoutMs, apiKey });
    } catch (e) {
      // Measured on the DGX (Ollama 0.32.15): a 9,144-token evaluation returns
      // 400 "... exceeds the available context size (4096)". That is the single most likely reason a
      // local model fails in production, and the raw message does not say what to do about it — so
      // say it here, once, at the point of failure. It stays a 400 (non-retryable): re-sending the
      // same oversized transcript four times cannot make it fit.
      if (/context (size|length)|exceeds the available context/i.test(e?.message || '')) {
        const hint = `The server is serving "${model}" with too small a context window for a CLE transcript. Raise it server-side (Ollama: OLLAMA_CONTEXT_LENGTH or a Modelfile \`PARAMETER num_ctx\`; vLLM: --max-model-len), or set LOCAL_AI_NUM_CTX if this server honours a per-request override.`;
        const err = new Error(`${e.message} — ${hint}`);
        err.status = e.status;
        err.contextTooSmall = true;
        throw err;
      }
      throw e;
    }

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

/**
 * Embed one string on the local box, via the same OpenAI-compatible surface (`POST /embeddings`).
 *
 * Kept in THIS module rather than a third provider file because it is the same host, the same key
 * and the same transport as chat — only the endpoint and the model differ. It deliberately does NOT
 * go through getRunner(): embedding is a sub-second call on every physician turn, and putting it in
 * the same FIFO as 150-second evaluations would let one scoring call stall every chat lookup behind it.
 */
async function embed(text) {
  const { baseUrl, embedModel, apiKey } = cfg();
  if (!baseUrl) throw new Error('LOCAL_AI_BASE_URL is not set (embed provider "local" requires it)');
  if (!embedModel) throw new Error('LOCAL_AI_EMBED_MODEL is not set (embed provider "local" requires it — the chat model is usually not an embedding model)');
  const timeoutMs = Math.max(2000, parseInt(process.env.LOCAL_AI_EMBED_TIMEOUT_MS || '15000', 10));
  const data = await httpJson(`${baseUrl}/embeddings`, {
    method: 'POST', body: { model: embedModel, input: text }, timeoutMs, apiKey,
  });
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('local embeddings response carried no vector');
  return vector;
}

/**
 * How much context the box will actually accept.
 *
 * This is the difference between a failure a physician discovers and one /health/deep reports. A
 * creditable CLE is >= 10,000 tokens (C3) and the evaluator sends the whole transcript, so a server
 * on Ollama's 4096 default fails EVERY evaluation — loudly, but only at the moment it matters.
 *
 * Ollama exposes the number on its native API, which sits beside the OpenAI-compatible one
 * (…/v1 → …/api). Other stacks (vLLM, SGLang) do not, and that is not a fault: an unknown context is
 * reported as unknown, never as unhealthy. Only a context we actually READ and found too small
 * degrades the check.
 */
async function servedContext() {
  const { baseUrl, model, apiKey } = cfg();
  const root = baseUrl.replace(/\/v1$/, '');
  if (root === baseUrl) return null;                       // not the …/v1 shape — no native API to ask
  const probeMs = Math.max(200, parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || '2000', 10));
  try {
    const data = await httpJson(`${root}/api/show`, { method: 'POST', body: { model }, timeoutMs: probeMs, apiKey });
    // The key is namespaced by architecture (`llama.context_length`, `qwen3.context_length`, …), so
    // match on the suffix rather than guessing the family.
    const info = data?.model_info || {};
    const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const n = Number(key ? info[key] : NaN);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;                                           // not Ollama, or the endpoint moved
  }
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
    // Serving the right model but unable to hold a transcript is still not ready — it is the
    // failure this probe was added for. Report the number when we can read it, and say so plainly
    // when we cannot, rather than implying a check that never ran.
    const ctx = await servedContext();
    const { minContext } = cfg();
    if (ctx != null && ctx < minContext) {
      return { checks: { local_ai: { status: 'down', model, context_length: ctx,
        error: `served context ${ctx} is below LOCAL_AI_MIN_CONTEXT ${minContext} — a creditable CLE transcript (C3 >= 10,000 tokens) cannot be evaluated at this size` } } };
    }
    return { checks: { local_ai: { status: 'up', model, context_length: ctx ?? 'unknown' } } };
  } catch (e) {
    return { checks: { local_ai: { status: 'down', error: e.message } } };
  }
}

module.exports = {
  name: 'local',
  call, embed,
  model: () => cfg().model,
  embedModel: () => cfg().embedModel,
  ready, servedContext,
  stats: () => getRunner().stats(),
};
