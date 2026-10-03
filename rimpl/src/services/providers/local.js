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
const settings = require('../provider-settings');

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
  // A creditable PLE needs C3 ≥ 10,000 tokens, and the evaluator sends the whole transcript. Anything
  // near Ollama's 4096 default cannot score one. Reported by ready() so the mismatch is visible in
  // /health/deep rather than discovered by a physician losing an evaluation.
  //
  // app_settings.local_ai_min_context -> LOCAL_AI_MIN_CONTEXT -> 16384, the same order and the same
  // fail-soft rule the provider names follow. The floor is what the readiness gate refuses against,
  // so raising it after measuring a real transcript must not need a redeploy of the RIMPL layer.
  minContext: settings.numberFor('local_ai_min_context') ?? intEnv('LOCAL_AI_MIN_CONTEXT', 16384, 1024),
  // OPT-IN passthrough. The authoritative fix for context length is server-side (the Modelfile /
  // launch flag); servers that accept an `options` bag will honour this, and those that ignore
  // unknown body fields are unaffected. Left unset by default so we never send a field a stricter
  // server would reject.
  numCtx: intEnv('LOCAL_AI_NUM_CTX', 0, 0),
  // Proactive size backstop (0 = off). A prompt estimated above this is refused BEFORE it takes a
  // queue slot or a network round-trip, with 413 transcript_too_large — the server's own 400 for
  // an over-long prompt only arrives after the box has already spent time on it. Set from the WP0
  // capacity probe (the largest size at which the served model still recalled the sentinel).
  maxPromptTokens: intEnv('LOCAL_AI_MAX_PROMPT_TOKENS', 0, 0),
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
  // Same terminal rule for a caller that hung up (tab closed, backend deadline): the reply would be
  // dead on arrival, and the slot a retry would hold is what the next caller is waiting for. Tagged
  // by httpJson from the caller's own signal, so it cannot be confused with our deadline above.
  if (err && err.aborted) return false;
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

// Which queue lane a purpose rides in (providers/runtime.js). Interactive = a human is waiting on
// the reply right now: a chat turn, the synchronous criteria call on /end, an auditor's discussion
// turn. Background = nobody is watching: a PIS-7 evaluation the backend drains from its queue, a
// shadow score. An unknown purpose goes to background — the safe default for a new purpose is to
// never cut ahead of a physician.
const LANE_FOR = { chat: 'interactive', criteria: 'interactive', discuss: 'interactive', evaluate: 'background', shadow: 'background' };
const laneFor = (purpose) => LANE_FOR[purpose] || 'background';

// A dedicated GPU box has no per-account quota, but it is NOT unbounded — throughput is capped by
// VRAM and the server's batch scheduler. Keep a limiter; size it from a measured burst, not from an
// assurance that "concurrency is not a problem".
//
// Default 2, down from 24, from the DGX measurement: one PIS-7 evaluation is p50 68s; at two
// concurrent p95 is 114s, at four 154s — over LOCAL_AI_TIMEOUT_MS, i.e. a slow evaluation becomes a
// failed one. And ONE shared FIFO meant a burst of evaluations parked the next physician's chat
// turn behind them, while nothing cancelled a queued call whose caller had already timed out, so a
// backend retry stacked a duplicate behind the original. Hence two lanes with an interactive
// reserve, a bounded depth (503 now beats a timeout later), and cancellation from the caller's signal.
let runner = null;
function getRunner() {
  if (!runner) {
    const maxConcurrency = intEnv('LOCAL_MAX_CONCURRENCY', 2, 1);
    const maxRetries = intEnv('LOCAL_MAX_RETRIES', 3, 0);
    const retryBaseMs = intEnv('LOCAL_RETRY_BASE_MS', 500, 1);
    let reserve = intEnv('LOCAL_INTERACTIVE_RESERVE', 1, 0);
    if (reserve >= maxConcurrency) {
      // A reserve that swallows every slot would leave evaluations queued forever (then 503'd). Clamp
      // rather than throw: on a one-slot box the lanes still order interactive first.
      console.warn(`[local-ai] LOCAL_INTERACTIVE_RESERVE=${reserve} is not below LOCAL_MAX_CONCURRENCY=${maxConcurrency}; clamping to ${maxConcurrency - 1} so background work can still run`);
      reserve = maxConcurrency - 1;
    }
    runner = createRunner({
      name: 'local',
      maxConcurrency,
      maxRetries,
      retryBaseMs,
      isRetryable,
      retryAfterMs,
      lanes: {
        reserve,
        maxQueue: {
          interactive: intEnv('LOCAL_MAX_QUEUE_INTERACTIVE', 4, 0),
          background: intEnv('LOCAL_MAX_QUEUE_BACKGROUND', 2, 0),
        },
        retryAfterMs: intEnv('LOCAL_QUEUE_RETRY_AFTER_S', 30, 1) * 1000,
      },
      onRetry: (err, attempt) => {
        const { active, queued, lanes } = runner.stats();
        // No anthropic-ratelimit-* headers exist here, so queue depth is the only saturation signal.
        console.warn(`[local-ai] retryable error (status ${err?.status ?? '?'}: ${err?.message ?? ''}), attempt ${attempt + 1}/${maxRetries} — in-flight:${active} queued:${queued} (interactive ${lanes.interactive.active} running/${lanes.interactive.queued} waiting, background ${lanes.background.active} running/${lanes.background.queued} waiting)`);
      },
    });
  }
  return runner;
}

// `signal` (optional) is the caller's own AbortSignal — combined with our deadline so either one
// cancels the request at the socket. An abort from the caller's signal is tagged `aborted`, our
// deadline `localTimeout`; both are terminal for isRetryable, for different reasons.
// The on-prem box lives on a Tailscale network the Railway container cannot route to. When rimpl
// runs OUTSIDE that network, `LOCAL_AI_HTTP_PROXY` points at a local Tailscale HTTP proxy and only
// THIS provider's requests go through it — never the Anthropic or Supabase calls, which must keep
// taking the normal path. A global dispatcher would send all of them down the tunnel.
//
// Unset (the on-prem deployment, and every test) → undefined → fetch behaves exactly as before.
let _dispatcher;
let _proxyFetch;
function proxyTransport() {
  const url = process.env.LOCAL_AI_HTTP_PROXY?.trim();
  if (!url) return { fetch: globalThis.fetch, dispatcher: undefined };
  if (!_dispatcher) {
    const undici = require('undici');
    _dispatcher = new undici.ProxyAgent({
      uri: url,
      proxyTunnel: true,
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    // Node 22's bundled fetch and Undici 8 use different dispatcher protocols. Keep the
    // proxied fetch and dispatcher from one package; the unproxied branch remains native fetch.
    _proxyFetch = undici.fetch;
  }
  return { fetch: _proxyFetch, dispatcher: _dispatcher };
}

// Test seam: the agent is memoised, so a suite changing the env needs a way to drop it.
function _resetDispatcher() { _dispatcher = undefined; _proxyFetch = undefined; }

async function httpJson(url, { method = 'GET', body, timeoutMs, apiKey, signal }) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const tag = (e) => {
    if (signal?.aborted) e.aborted = true;
    // Tag OUR deadline so isRetryable can tell it apart from a transient network blip (which IS
    // worth retrying). A server-side timeout arrives as an HTTP status instead and stays retryable.
    else if (e?.name === 'TimeoutError') e.localTimeout = true;
    return e;
  };
  let res;
  try {
    const transport = proxyTransport();
    res = await transport.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: transport.dispatcher, // undefined unless LOCAL_AI_HTTP_PROXY is set
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
    });
  } catch (e) {
    throw tag(e);
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
  try {
    return await res.json();   // the body read is under the same signal as the request
  } catch (e) {
    throw tag(e);
  }
}

// Raw prompt size without a tokenizer: UTF-8 bytes / 3. An INPUT to the calibration below, not a token
// count: Thai is three bytes a character, and the served tokenizer's ratio to this number is nothing
// like English's (measured on identical text, bytes/3 ran 1.34x the capacity probe's chars/4 for
// English and 3.37x for Thai). The backend's transcript cap, counted from the server's reported
// prompt_tokens, is the real budget; this only feeds the pre-send backstop.
function estimatePromptTokens(messages) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 3);
}

// ---------------------------------------------------------------------------------------------
// Self-calibrating size backstop. LOCAL_AI_MAX_PROMPT_TOKENS is in the SERVER's own unit —
// usage.prompt_tokens, the number the capacity probe reports and the transcript cap counts. The raw
// byte estimate is converted into that unit through a ratio learnt from served responses:
// ratio = est / prompt_tokens, an EWMA (alpha 0.2) over every successful call, plus a sample count.
//
// PRE-CALIBRATION WINDOW (fewer than CALIBRATION_MIN_SAMPLES served calls): the backstop does NOT
// pre-reject, deliberately. A wrong ratio rejects work the box can do — with the uncalibrated bytes/3
// compared straight against the limit, a Thai PLE the box had just proved it can hold was refused
// at ~30% of real capacity, which the backend turned into 403 transcript_limit_reached (chat) or
// ple_flag_t2 (evaluate). A genuinely too-large prompt is still caught inside that window by the
// server's own 400, rewritten to 413 in call(). Module-level, per process: a restart learns afresh
// from the first served call.
const CALIBRATION_ALPHA = 0.2;
const CALIBRATION_MIN_SAMPLES = 3;
let calibration = { ratio: null, n: 0 };

// Fold one served response into the ratio. Numbers only — never the prompt.
function observePromptTokens(est, promptTokens) {
  if (!(est > 0) || typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
  const sample = est / promptTokens;
  const ratio = calibration.n === 0 ? sample : calibration.ratio + CALIBRATION_ALPHA * (sample - calibration.ratio);
  calibration = { ratio, n: calibration.n + 1 };
  // How the ratio is observed on a box BEFORE anyone sets the limit. Off unless LOCAL_LOG_PROMPT_RATIO=1,
  // so a busy box does not write a line per call; /health/deep queues.local.prompt_calibration carries
  // the same two numbers without it.
  if (process.env.LOCAL_LOG_PROMPT_RATIO === '1') {
    console.debug(`[local] prompt est=${est} served=${promptTokens} ratio=${ratio.toFixed(3)} n=${calibration.n}`);
  }
}

// The raw estimate in SERVER prompt tokens, or null while uncalibrated.
function predictPromptTokens(est) {
  if (calibration.n < CALIBRATION_MIN_SAMPLES || !(calibration.ratio > 0)) return null;
  return est / calibration.ratio;
}

// For stats() / /health/deep and the 413 body: { ratio (3dp) | null, n }. Two numbers, nothing else.
function promptCalibration() {
  return { ratio: calibration.ratio == null ? null : Number(calibration.ratio.toFixed(3)), n: calibration.n };
}

// OpenAI `finish_reason` → Anthropic `stop_reason` vocabulary. This mapping is load-bearing:
// routes/evaluate.js branches on 'max_tokens' (genuinely truncated → needs a bigger ceiling) vs
// 'end_turn' (model finished without emitting JSON → a compliance problem a bigger ceiling can't
// fix). Translating here keeps that diagnosis provider-agnostic.
const FINISH_REASON = { length: 'max_tokens', stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'content_filter' };

// The inference engine, from the server's own `system_fingerprint`. §10.2 of the Model Lock Record
// asks for the engine and its version; vLLM answers with both on every completion —
// `vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0` — and until 2026-09-05 rimpl never read the
// field, so served scores recorded engine and runtime null while the answer arrived in plain sight
// on every call (GATE0 §8.10).
//
// Only a RECOGNISED leading token becomes `engine`; anything else stays null rather than becoming a
// guess. OpenAI's fingerprints look like `fp_44709d6fcb`, and writing that into a field an auditor
// reads as "inference engine" is worse than leaving it empty. Nothing is lost by being strict: the
// raw string is recorded verbatim as `runtime` either way, which is what an auditor can actually
// check, and parsing a vendor string into parts is how the NEXT engine gets mis-recorded.
const KNOWN_ENGINES = new Set(['vllm', 'ollama', 'llamacpp', 'tgi', 'sglang', 'mlx', 'trtllm', 'lmdeploy']);
function engineOf(fingerprint) {
  const head = String(fingerprint || '').split('-')[0].trim().toLowerCase();
  return KNOWN_ENGINES.has(head) ? head : null;
}

// `purpose` picks the queue lane (LANE_FOR); `signal` is the caller's client-gone signal — while
// queued it drops the waiter, in flight it cancels the request at the socket. Both optional.
async function call({ systemPrompt, messages, maxTokens = 1500, temperature, purpose, signal }) {
  const { baseUrl, model, apiKey, timeoutMs, numCtx, maxPromptTokens } = cfg();
  if (!baseUrl) throw new Error('LOCAL_AI_BASE_URL is not set (AI_PROVIDER=local requires it)');
  if (!model) throw new Error('LOCAL_AI_MODEL is not set (AI_PROVIDER=local requires it)');

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

  // Size backstop BEFORE the queue: a prompt that cannot fit must not take a slot from one that can,
  // and must not be retried (it cannot shrink). The error carries numbers only — never the text.
  // Compared in the SERVER's unit through the learnt ratio; while uncalibrated (null) it never
  // pre-rejects — see the calibration notes above.
  const est = estimatePromptTokens(body.messages);
  const predicted = predictPromptTokens(est);
  if (maxPromptTokens > 0 && predicted != null && predicted > maxPromptTokens) {
    const err = new Error(`local AI request refused before send: the prompt is a predicted ${Math.round(predicted)} server tokens (bytes/3 estimate ${est} through a learnt ratio of ${calibration.ratio.toFixed(3)} over ${calibration.n} served calls), above LOCAL_AI_MAX_PROMPT_TOKENS=${maxPromptTokens}; the transcript has to be shortened — re-sending cannot make it fit`);
    err.status = 413;
    err.contextTooSmall = true;
    err.code = 'transcript_too_large';
    err.est_tokens = Math.round(predicted);
    err.limit = maxPromptTokens;
    err.calibration = promptCalibration();
    throw err;
  }

  return getRunner().run(async (_attempt, sig) => {
    let data;
    try {
      data = await httpJson(`${baseUrl}/chat/completions`, { method: 'POST', body, timeoutMs, apiKey, signal: sig });
    } catch (e) {
      // Measured on the DGX (Ollama 0.32.15): a 9,144-token evaluation returns
      // 400 "... exceeds the available context size (4096)". That is the single most likely reason a
      // local model fails in production, and the raw message does not say what to do about it — so
      // say it here, once, at the point of failure. It stays a 400 (non-retryable): re-sending the
      // same oversized transcript four times cannot make it fit.
      if (/context (size|length)|exceeds the available context/i.test(e?.message || '')) {
        const hint = `The server is serving "${model}" with too small a context window for a PLE transcript. Raise it server-side (Ollama: OLLAMA_CONTEXT_LENGTH or a Modelfile \`PARAMETER num_ctx\`; vLLM: --max-model-len), or set LOCAL_AI_NUM_CTX if this server honours a per-request override.`;
        const err = new Error(`${e.message} — ${hint}`);
        err.status = e.status;
        err.contextTooSmall = true;
        // Same vocabulary as the proactive backstop above, so the route answers 413
        // transcript_too_large either way and the backend has one case to handle, not two.
        err.code = 'transcript_too_large';
        // Same unit as `limit` once calibrated (server tokens); the raw bytes/3 estimate before that.
        err.est_tokens = predicted != null ? Math.round(predicted) : est;
        err.limit = maxPromptTokens > 0 ? maxPromptTokens : null;
        err.calibration = promptCalibration();
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
    observePromptTokens(est, data.usage?.prompt_tokens);
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
      // Same purpose, same source of truth: what the server says it is running. `runtime` is the
      // fingerprint verbatim (the version lives inside it); `engine` is the recognised name or null.
      // QUANTIZATION IS NOT HERE and is not derivable from this response — §10.2's third field stays
      // null on this transport, which is the honest answer rather than one inferred from a model name.
      runtime: data.system_fingerprint || null,
      engine: engineOf(data.system_fingerprint),
      // What this call SENT, for §10.2 provenance (routes/evaluate.js), in the same shape the
      // anthropic provider reports. This transport sends no thinking mode and no effort, so both are null.
      decoding: { temperature: body.temperature ?? null, thinking: null, effort: null },
    };
  }, { lane: laneFor(purpose), signal });
}

/**
 * Embed one string on the local box, via the same OpenAI-compatible surface (`POST /embeddings`).
 *
 * Kept in THIS module rather than a third provider file because it is the same host, the same key
 * and the same transport as chat — only the endpoint and the model differ. It deliberately does NOT
 * go through getRunner(): embedding is a sub-second call on every physician turn, and putting it in
 * the same queue as 150-second evaluations would let one scoring call stall every chat lookup behind it.
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
 * creditable PLE is >= 10,000 tokens (C3) and the evaluator sends the whole transcript, so a server
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
    // `min_context` travels with BOTH outcomes, not only the failing one. The caller is a gate that
    // reports "measured X, needs Y" as structured fields, and digging those numbers back out of the
    // prose is what left the production 409 carrying measured: null while the sentence said 4096.
    if (ctx != null && ctx < minContext) {
      return { checks: { local_ai: { status: 'down', model, context_length: ctx, min_context: minContext,
        error: `served context ${ctx} is below the required minimum ${minContext} — a creditable PLE transcript (C3 >= 10,000 tokens) cannot be evaluated at this size` } } };
    }
    return { checks: { local_ai: { status: 'up', model, context_length: ctx ?? 'unknown', min_context: minContext } } };
  } catch (e) {
    return { checks: { local_ai: { status: 'down', error: e.message } } };
  }
}

module.exports = {
  _resetDispatcher,
  name: 'local',
  call, embed,
  model: () => cfg().model,
  embedModel: () => cfg().embedModel,
  ready, servedContext,
  // Queue depth plus the learnt prompt-size calibration, so /health/deep shows the ratio the backstop
  // would use before anyone sets LOCAL_AI_MAX_PROMPT_TOKENS.
  stats: () => ({ ...getRunner().stats(), prompt_calibration: promptCalibration() }),
  LANE_FOR, laneFor, estimatePromptTokens, promptCalibration,
};
