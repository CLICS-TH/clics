// The OpenAI-compatible on-prem transport, as a FACTORY: one instance per inference endpoint.
//
// WHY A FACTORY (CCME requirement R3, docs/ARCHITECTURE-MAPPING-CCME.md): the PIS-7 evaluator must
// be a distinct model artifact from the tutor. The two can be served by DIFFERENT boxes with different
// keys (DeepSeek for evaluate/criteria, CCME's Qwen for chat/discuss), and each needs its own queue,
// its own deadline, its own prompt-size calibration and its own /health/deep check. A module-level
// singleton could only ever point at one of them.
//
// Every piece of mutable state (the runner with its queue and retries, the learnt prompt-token ratio,
// the warn-once flags) lives INSIDE an instance, so a burst on the tutor box can never make the
// evaluator's queue answer queue_full, and one box's tokenizer ratio can never size the other's
// backstop. The only thing instances share is the proxy-agent cache below, keyed by proxy URL: an
// agent is a connection pool to the Tailscale proxy, not state about any one endpoint.
//
// The instances:
//   providers/local.js        name 'local'        env LOCAL_AI_* / LOCAL_*              the EVALUATOR
//   providers/local-tutor.js  name 'local-tutor'  env LOCAL_TUTOR_AI_* / LOCAL_TUTOR_*  the tutor
//
// The name 'local' is load-bearing and must stay the evaluator's: lib/prompts.js pis7PromptFor (the
// local addendum), lib/versions.js promptVersionFor (the +local- suffix), routes/evaluate.js
// consistencyModeFor and services/shadow.js all key on it, and the historical scores, shadow rows and
// the calibration record are stamped with it.
//
// PII: nothing here de-identifies anything. The boundary sits UPSTREAM in the routes
// (services/pii-filter.js + lib/transcript.js) and must stay there; a provider is a transport.
//
// TRANSPORT SECURITY: plain http:// is acceptable ONLY across the tailnet, which is WireGuard-
// encrypted end to end. Never point a *_BASE_URL at a plaintext public address.
const { createRunner } = require('./runtime');
const settings = require('../provider-settings');
const { stripThink, createThinkFilter, closesThink, flagOn } = require('../../lib/think-markup');
const { THINKING_STYLES, thinkingEnabled, parseThinkingStyle, thinkingFields } = require('../../lib/thinking-control');
const { LOCAL_NUM_CTX_DEFAULT, KNOWN_ENGINES: ENGINE_NAMES } = require('../../lib/provider-policy');
const { emptyReplyError } = require('../../lib/ai-errors');

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

// The on-prem box lives on a Tailscale network the Railway container cannot route to. When rimpl
// runs OUTSIDE that network, an instance's proxy env (LOCAL_AI_HTTP_PROXY for `local`) points at a
// local Tailscale HTTP proxy and only the LOCAL providers' requests go through it — never the
// Anthropic or Supabase calls, which must keep taking the normal path. A global dispatcher would send
// all of them down the tunnel.
//
// Unset (the on-prem deployment, and every test) → no proxy → fetch behaves exactly as before.
// One agent per proxy URL, shared by every instance that names the same proxy.
const _transports = new Map();
function proxyTransport(url) {
  if (!url) return { fetch: globalThis.fetch, dispatcher: undefined };
  let t = _transports.get(url);
  if (!t) {
    const undici = require('undici');
    t = {
      dispatcher: new undici.ProxyAgent({
        uri: url,
        proxyTunnel: true,
        headersTimeout: 0,
        bodyTimeout: 0,
      }),
      // Node 22's bundled fetch and Undici 8 use different dispatcher protocols. Keep the
      // proxied fetch and dispatcher from one package; the unproxied branch remains native fetch.
      fetch: undici.fetch,
    };
    _transports.set(url, t);
  }
  return t;
}

// Test seam: the agents are memoised, so a suite changing the env needs a way to drop them.
function _resetDispatcher() { _transports.clear(); }

// `signal` (optional) is the caller's own AbortSignal — combined with our deadline so either one
// cancels the request at the socket. An abort from the caller's signal is tagged `aborted`, our
// deadline `localTimeout`; both are terminal for isRetryable, for different reasons.
// `label` names the endpoint in error messages ('local AI' for the evaluator, unchanged).
async function httpJson(url, { method = 'GET', body, timeoutMs, apiKey, signal, proxyUrl, label = 'local AI' }) {
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
    const transport = proxyTransport(proxyUrl);
    res = await transport.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: transport.dispatcher, // undefined unless this instance's proxy env is set
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
    });
  } catch (e) {
    throw tag(e);
  }
  if (!res.ok) {
    // Attach .status (and the headers) so isRetryable/retryAfterMs behave exactly as they do for the
    // Anthropic SDK's error objects — a 429/503 from vLLM must retry, a 400 must not.
    const detail = await res.text().catch(() => '');
    const err = new Error(`${label} ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
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

// ---------------------------------------------------------------------------------------------
// Inline reasoning markup (<think>…</think> in `content`) — stripThink / createThinkFilter live in
// lib/think-markup.js, package-free, so the probe/quality harness judges the very text this transport
// returns. See that file for exactly what is and is not withheld from a stream. Per instance,
// <envPrefix>THINK_PREOPENED=1 declares that the server's chat template opens the block inside the
// prompt (DeepSeek-R1, Qwen3 Thinking-2507), so nothing is shown or returned until the first </think>.

// The streaming twin of httpJson: POST with `stream: true` and read the OpenAI-style SSE body,
// `data: {chunk}` lines ending in `data: [DONE]`. Each content piece goes to `onDelta` as it arrives
// (through the think filter above); the resolved value has the SAME shape as a non-streamed
// completion (choices[0].message.content — the RAW content, stripped by the caller —, finish_reason,
// usage, model, system_fingerprint), so call() reads both the same way. Only `delta.content` strings
// are taken: reasoning_content (chain-of-thought) is dropped, as in call(); its ARRIVAL is reported to
// `onReasoning()` (no content passed), which call() limits to once.
//
// `preopened` starts the filter inside a reasoning block (the THINK_PREOPENED knob); `onOrphanClose`
// is told, once, when a </think> arrives that no <think> opened — see lib/think-markup.js.
async function httpStream(url, { body, timeoutMs, apiKey, signal, onDelta, onReasoning, onOrphanClose, preopened = false, proxyUrl, label = 'local AI' }) {
  const headers = { accept: 'text/event-stream', 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const tag = (e) => {
    if (signal?.aborted) e.aborted = true;
    else if (e?.name === 'TimeoutError') e.localTimeout = true;
    return e;
  };
  let res;
  try {
    const transport = proxyTransport(proxyUrl);
    res = await transport.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: transport.dispatcher,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
    });
  } catch (e) {
    throw tag(e);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`${label} ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    err.headers = res.headers;
    throw err;
  }
  // `emitted` = text has actually been SHOWN. Reasoning withheld by the filter does not count: a
  // failure after nothing but reasoning is still safe to retry, the physician has seen no reply.
  let emitted = false;
  const filter = createThinkFilter({ emit: (t) => { emitted = true; onDelta(t); }, onThink: onReasoning, onOrphanClose, preopened });
  // A server that ignores `stream` answers with one JSON completion: hand its text over in one piece.
  if (/application\/json/i.test(res.headers?.get?.('content-type') || '')) {
    let data;
    try { data = await res.json(); } catch (e) { throw tag(e); }
    const whole = data?.choices?.[0]?.message?.content;
    if (typeof whole === 'string' && whole) { filter.push(whole); filter.end(); }
    return data;
  }
  let text = '', finish = null, usage = null, model = null, fingerprint = null;
  let sawDone = false;
  // Protocol failures carry noRetry once text has gone out, like every other mid-stream failure.
  const protocolError = (msg) => Object.assign(new Error(`${label} stream: ${msg}`), { status: 502, code: 'stream_incomplete', ...(emitted ? { noRetry: true } : {}) });
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; continue; }
        let j;
        try { j = JSON.parse(payload); } catch { continue; }   // a keep-alive or a torn line: skip it
        // vLLM / proxies report a failure mid-stream as a data line with an `error` object (status 200).
        if (j.error) throw protocolError(`server error ${String(j.error.message || j.error.type || '').slice(0, 200)}`);
        if (j.model) model = j.model;
        if (j.system_fingerprint) fingerprint = j.system_fingerprint;
        if (j.usage) usage = j.usage;
        const c = j.choices?.[0];
        if (c?.finish_reason) finish = c.finish_reason;
        // vLLM/SGLang name it reasoning_content; Ollama's and some gateways' OpenAI surface `reasoning`.
        // Only the fact that it arrived leaves this function — never the text.
        const thought = c?.delta?.reasoning_content ?? c?.delta?.reasoning;
        if (typeof thought === 'string' && thought) onReasoning?.();
        const piece = c?.delta?.content;
        if (typeof piece === 'string' && piece) {
          text += piece;
          filter.push(piece);
        }
      }
    }
  } catch (e) {
    const err = e?.code === 'stream_incomplete' ? e : tag(e);
    if (emitted) err.noRetry = true;
    throw err;
  }
  // A body that just stops (no [DONE], no finish_reason) is a cut-off reply, not a finished one: storing
  // it would put half an answer in the transcript as if the model had meant it.
  if (!sawDone && !finish) throw protocolError('the reply ended before the server finished it');
  filter.end();
  return {
    choices: [{ message: { content: text }, finish_reason: finish }],
    usage, model, system_fingerprint: fingerprint,
  };
}

// Raw prompt size without a tokenizer: UTF-8 bytes / 3. An INPUT to the calibration below, not a token
// count: Thai is three bytes a character, and the served tokenizer's ratio to this number is nothing
// like English's (measured on identical text, bytes/3 ran 1.34x the capacity probe's chars/4 for
// English and 3.37x for Thai). The backend's transcript cap, counted from the server's reported
// prompt_tokens, is the real budget; this only feeds the pre-send backstop.
function estimatePromptTokens(messages) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 3);
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
const KNOWN_ENGINES = new Set(ENGINE_NAMES);   // lib/provider-policy.js, the one list
function engineOf(fingerprint) {
  const head = String(fingerprint || '').split('-')[0].trim().toLowerCase();
  return KNOWN_ENGINES.has(head) ? head : null;
}

// ---------------------------------------------------------------------------------------------
// Thinking control (optional, per request). `thinking` is true/false or { enabled, budget? }; null
// means the caller did not ask, and is the ONLY case in which the request is byte-identical to before
// the field existed. How it is sent depends on the SERVER, so it is per instance:
//   <envPrefix>THINKING_STYLE = none (default — send nothing, ever)
//                             | chat_template_kwargs  (vLLM / SGLang: { chat_template_kwargs: { enable_thinking } })
//                             | ollama                 (Ollama: { think })
// `budget` is accepted for the caller's interface, but none of these has a portable field for it,
// so it is not sent. The Anthropic provider ignores `thinking` altogether. The mapping itself lives in
// lib/thinking-control.js (package-free), shared with the probe/quality harness.

/**
 * Build one OpenAI-compatible on-prem provider.
 *
 * @param {object}   o
 * @param {string}   o.name           the provider name: the PROVIDERS key in services/ai.js and what
 *                                    every result, provenance row and bill is stamped with
 * @param {string}   o.envPrefix      connection env: <prefix>BASE_URL / MODEL / API_KEY / TIMEOUT_MS /
 *                                    MIN_CONTEXT / NUM_CTX / MAX_PROMPT_TOKENS / THINKING_STYLE /
 *                                    EMBED_MODEL / EMBED_TIMEOUT_MS / HTTP_PROXY / MAX_TOKENS_FLOOR_<PURPOSE>
 * @param {string}   o.queuePrefix    runner env: <prefix>MAX_CONCURRENCY / MAX_RETRIES / RETRY_BASE_MS /
 *                                    INTERACTIVE_RESERVE / MAX_QUEUE_INTERACTIVE / MAX_QUEUE_BACKGROUND /
 *                                    QUEUE_RETRY_AFTER_S / LOG_PROMPT_RATIO
 * @param {string}   o.checkKey       this instance's key in ready().checks — must be unique, because
 *                                    services/ai.js readiness() merges every provider's checks into one map
 * @param {string}   o.minContextKey  the app_settings number that overrides <prefix>MIN_CONTEXT
 * @param {string[]} [o.proxyEnv]     env names for the HTTP proxy, in order: the first one that is SET
 *                                    wins, even set to the empty string (= go direct)
 * @param {boolean}  [o.embeddings]   whether embed()/embedModel() are exported (a registry decision
 *                                    lives in services/ai.js EMBED_PROVIDERS; this only gates the surface)
 * @param {string}   [o.label]        how errors name the endpoint
 */
function createLocalProvider({
  name, envPrefix, queuePrefix, checkKey, minContextKey,
  proxyEnv = [`${envPrefix}HTTP_PROXY`], embeddings = true, label = 'local AI',
}) {
  const log = `[${name}-ai]`;

  const cfg = () => ({
    baseUrl: String(process.env[`${envPrefix}BASE_URL`] || '').replace(/\/+$/, ''),
    model: String(process.env[`${envPrefix}MODEL`] || ''),
    apiKey: process.env[`${envPrefix}API_KEY`] || '',
    // 150s, not the original 85s. 85s was chosen to match the Anthropic SDK ceiling, but two measured
    // evaluations on the DGX took 82.5s and 87.8s — one of them already over. A ceiling that sits at
    // the middle of the observed distribution turns a slow-but-correct evaluation into a failed one.
    // Must stay UNDER backend's RIMPL_EVAL_TIMEOUT_MS (now 180s) or the outer caller hangs up first
    // and every retry is dead work; see services/rimpl-client.js.
    timeoutMs: intEnv(`${envPrefix}TIMEOUT_MS`, 150000, 1000),
    // The model that serves /embeddings. Usually NOT the chat model — embedding models are separate
    // checkpoints (nomic-embed-text, bge-m3, …) even on the same box.
    embedModel: String(process.env[`${envPrefix}EMBED_MODEL`] || ''),
    // A creditable PLE needs C3 ≥ 10,000 tokens, and the evaluator sends the whole transcript (the
    // tutor resends the whole history every turn). Anything near Ollama's 4096 default cannot hold
    // one. Reported by ready() so the mismatch is visible in /health/deep rather than discovered by a
    // physician losing a session.
    //
    // app_settings.<minContextKey> -> <prefix>MIN_CONTEXT -> 16384, the same order and the same
    // fail-soft rule the provider names follow. The floor is what the readiness gate refuses against,
    // so raising it after measuring a real transcript must not need a redeploy of the RIMPL layer.
    minContext: settings.numberFor(minContextKey) ?? intEnv(`${envPrefix}MIN_CONTEXT`, 16384, 1024),
    // OPT-IN passthrough. The authoritative fix for context length is server-side (the Modelfile /
    // launch flag); servers that accept an `options` bag will honour this, and those that ignore
    // unknown body fields are unaffected. Left unset by default so we never send a field a stricter
    // server would reject.
    numCtx: intEnv(`${envPrefix}NUM_CTX`, LOCAL_NUM_CTX_DEFAULT, 0),
    // Proactive size backstop (0 = off). A prompt estimated above this is refused BEFORE it takes a
    // queue slot or a network round-trip, with 413 transcript_too_large — the server's own 400 for
    // an over-long prompt only arrives after the box has already spent time on it. Set from the WP0
    // capacity probe (the largest size at which the served model still recalled the sentinel).
    maxPromptTokens: intEnv(`${envPrefix}MAX_PROMPT_TOKENS`, 0, 0),
    // The chat template opens the reasoning block INSIDE THE PROMPT (DeepSeek-R1, Qwen3
    // Thinking-2507 on a server without --reasoning-parser): the reply is `…reasoning…</think>answer`.
    // On, nothing is streamed or returned until the first </think>, and a reply that never closes the
    // block is an error rather than a blank or a leak (see call()). Off (default): unchanged.
    thinkPreopened: flagOn(process.env[`${envPrefix}THINK_PREOPENED`]),
  });

  const proxyUrl = () => {
    for (const k of proxyEnv) {
      if (process.env[k] !== undefined) return String(process.env[k]).trim();
    }
    return '';
  };

  // A typo here must not silently send a field the server rejects, nor silently pretend thinking was
  // controlled: fall back to `none` (send nothing) and say so once. Only read when a caller actually
  // passed `thinking`, or the chat router asks supportsThinking() (router_enabled), so a deployment that
  // never uses either never sees the warning.
  let warnedThinkingStyle = false;
  function thinkingStyle() {
    const raw = process.env[`${envPrefix}THINKING_STYLE`];
    const style = parseThinkingStyle(raw);
    if (style) return style;
    if (!warnedThinkingStyle) {
      warnedThinkingStyle = true;
      console.warn(`${log} ${envPrefix}THINKING_STYLE="${String(raw).trim().toLowerCase()}" is not one of ${THINKING_STYLES.join(' | ')} — sending no thinking control`);
    }
    return 'none';
  }

  // What the SERVER last said it was, from a completed call: the model id it reported and its
  // system_fingerprint (engine + runtime). ready() only reaches /models, which reports neither the
  // engine nor its build, so this is the only place they are ever observed. Read by the model manifest's
  // live view (services/manifest.js) — the configuration a lock is compared against is the one that
  // ANSWERED, not the one that was asked for. Never the prompt, never the reply; null until a call lands.
  let lastSeen = null;

  // Does this instance honour a `thinking` request at all? services/ai.js providerSupportsThinking asks,
  // so routes/chat.js applies the fast/deep router (services/router.js) only where a tier changes what
  // the server does. True iff <envPrefix>THINKING_STYLE names a style that sends a field. It proves the
  // operator's DECLARATION, not that the served model can switch reasoning off: a template that ignores
  // the field (DeepSeek-R1) still thinks on a "fast" turn. Read per call, like every other knob here.
  function supportsThinking() {
    return thinkingStyle() !== 'none';
  }

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
      const maxConcurrency = intEnv(`${queuePrefix}MAX_CONCURRENCY`, 2, 1);
      const maxRetries = intEnv(`${queuePrefix}MAX_RETRIES`, 3, 0);
      const retryBaseMs = intEnv(`${queuePrefix}RETRY_BASE_MS`, 500, 1);
      let reserve = intEnv(`${queuePrefix}INTERACTIVE_RESERVE`, 1, 0);
      if (reserve >= maxConcurrency) {
        // A reserve that swallows every slot would leave evaluations queued forever (then 503'd). Clamp
        // rather than throw: on a one-slot box the lanes still order interactive first.
        console.warn(`${log} ${queuePrefix}INTERACTIVE_RESERVE=${reserve} is not below ${queuePrefix}MAX_CONCURRENCY=${maxConcurrency}; clamping to ${maxConcurrency - 1} so background work can still run`);
        reserve = maxConcurrency - 1;
      }
      runner = createRunner({
        name,
        maxConcurrency,
        maxRetries,
        retryBaseMs,
        isRetryable,
        // A streamed attempt that has already handed text to the caller is marked noRetry: a second
        // attempt would show the physician a second, different reply after the first.
        shouldRetry: (err) => err?.noRetry !== true && isRetryable(err),
        retryAfterMs,
        lanes: {
          reserve,
          maxQueue: {
            interactive: intEnv(`${queuePrefix}MAX_QUEUE_INTERACTIVE`, 4, 0),
            background: intEnv(`${queuePrefix}MAX_QUEUE_BACKGROUND`, 2, 0),
          },
          retryAfterMs: intEnv(`${queuePrefix}QUEUE_RETRY_AFTER_S`, 30, 1) * 1000,
        },
        onRetry: (err, attempt) => {
          const { active, queued, lanes } = runner.stats();
          // No anthropic-ratelimit-* headers exist here, so queue depth is the only saturation signal.
          console.warn(`${log} retryable error (status ${err?.status ?? '?'}: ${err?.message ?? ''}), attempt ${attempt + 1}/${maxRetries} — in-flight:${active} queued:${queued} (interactive ${lanes.interactive.active} running/${lanes.interactive.queued} waiting, background ${lanes.background.active} running/${lanes.background.queued} waiting)`);
        },
      });
    }
    return runner;
  }

  // -------------------------------------------------------------------------------------------
  // Self-calibrating size backstop. <prefix>MAX_PROMPT_TOKENS is in the SERVER's own unit —
  // usage.prompt_tokens, the number the capacity probe reports and the transcript cap counts. The raw
  // byte estimate is converted into that unit through a ratio learnt from served responses:
  // ratio = est / prompt_tokens, an EWMA (alpha 0.2) over every successful call, plus a sample count.
  //
  // PRE-CALIBRATION WINDOW (fewer than CALIBRATION_MIN_SAMPLES served calls): the backstop does NOT
  // pre-reject, deliberately. A wrong ratio rejects work the box can do — with the uncalibrated bytes/3
  // compared straight against the limit, a Thai PLE the box had just proved it can hold was refused
  // at ~30% of real capacity, which the backend turned into 403 transcript_limit_reached (chat) or
  // ple_flag_t2 (evaluate). A genuinely too-large prompt is still caught inside that window by the
  // server's own 400, rewritten to 413 in call(). Per instance AND per process: two boxes run two
  // tokenizers, and a restart learns afresh from the first served call.
  const CALIBRATION_ALPHA = 0.2;
  const CALIBRATION_MIN_SAMPLES = 3;
  let calibration = { ratio: null, n: 0 };

  // Fold one served response into the ratio. Numbers only — never the prompt.
  function observePromptTokens(est, promptTokens) {
    if (!(est > 0) || typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
    const sample = est / promptTokens;
    const ratio = calibration.n === 0 ? sample : calibration.ratio + CALIBRATION_ALPHA * (sample - calibration.ratio);
    calibration = { ratio, n: calibration.n + 1 };
    // How the ratio is observed on a box BEFORE anyone sets the limit. Off unless <queuePrefix>LOG_PROMPT_RATIO=1,
    // so a busy box does not write a line per call; /health/deep queues.<name>.prompt_calibration
    // carries the same two numbers without it.
    if (process.env[`${queuePrefix}LOG_PROMPT_RATIO`] === '1') {
      console.debug(`[${name}] prompt est=${est} served=${promptTokens} ratio=${ratio.toFixed(3)} n=${calibration.n}`);
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

  // Inline <think> markup means the server is not separating reasoning. Said once per instance, with no
  // text from the reply: the operator needs to know the server is misconfigured, not what it thought.
  let warnedNoStreamUsage = false;
  let warnedThinkMarkup = false;
  let warnedThinkLeak = false;
  function warnThinkMarkup() {
    if (warnedThinkMarkup) return;
    warnedThinkMarkup = true;
    console.warn(`${log} the reply carried inline <think> markup in its content; it was removed before the reply was returned. Configure the server to return reasoning separately (vLLM/SGLang: --reasoning-parser).`);
  }
  // The one case a stream SHOWS reasoning: the template pre-opened the block and this instance was not
  // told, so pieces before the </think> went out as if they were the answer. Names the knob that stops
  // it. No reply text, ever.
  function warnThinkLeak() {
    if (warnedThinkLeak) return;
    warnedThinkLeak = true;
    console.warn(`${log} streamed text before a closing </think> with no opening tag had ALREADY been shown to the caller: the server's chat template opens the reasoning block inside the prompt. Set ${envPrefix}THINK_PREOPENED=1 to withhold everything until the first </think> — or, properly, run the server with --reasoning-parser.`);
  }

  // `purpose` picks the queue lane (LANE_FOR); `signal` is the caller's client-gone signal — while
  // queued it drops the waiter, in flight it cancels the request at the socket. Both optional.
  // `onDelta(text)` (optional) streams the reply — see httpStream. The resolved result is unchanged.
  // `thinking` (optional) — see THINKING_STYLES above. `onReasoning()` (optional, streamed calls only)
  // is called ONCE, with nothing, when the reply's reasoning starts arriving — so a caller can show
  // "thinking…" without ever receiving the reasoning itself.
  async function call({ systemPrompt, messages, maxTokens = 1500, temperature, purpose, signal, onDelta, thinking, onReasoning }) {
    const { baseUrl, model, apiKey, timeoutMs, numCtx, maxPromptTokens, thinkPreopened } = cfg();
    if (!baseUrl) throw new Error(`${envPrefix}BASE_URL is not set (AI_PROVIDER=${name} requires it)`);
    if (!model) throw new Error(`${envPrefix}MODEL is not set (AI_PROVIDER=${name} requires it)`);

    // Anthropic takes `system` as a top-level parameter; OpenAI-compatible servers take it as the
    // first message of the conversation.
    // A reasoning model spends its reasoning out of max_tokens, so a ceiling sized for the answer alone
    // (criteria's 200) can end mid-thought with no answer. <prefix>MAX_TOKENS_FLOOR_<PURPOSE> raises the
    // ceiling for this endpoint only; unset or invalid sends the caller's value unchanged.
    const floor = purpose ? intEnv(`${envPrefix}MAX_TOKENS_FLOOR_${String(purpose).toUpperCase()}`, 0, 1) : 0;
    const body = {
      model,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
      max_tokens: Math.max(maxTokens, floor),
      stream: !!onDelta,
    };
    // Usage arrives in a final chunk only when asked for; without it a streamed turn would bill 0 tokens.
    if (onDelta) body.stream_options = { include_usage: true };
    if (temperature != null) body.temperature = temperature;
    if (numCtx > 0) body.options = { ...(body.options || {}), num_ctx: numCtx };
    const thinkingOn = thinkingEnabled(thinking);
    if (thinkingOn != null) Object.assign(body, thinkingFields(thinkingStyle(), thinkingOn));

    // Size backstop BEFORE the queue: a prompt that cannot fit must not take a slot from one that can,
    // and must not be retried (it cannot shrink). The error carries numbers only — never the text.
    // Compared in the SERVER's unit through the learnt ratio; while uncalibrated (null) it never
    // pre-rejects — see the calibration notes above.
    const est = estimatePromptTokens(body.messages);
    const predicted = predictPromptTokens(est);
    if (maxPromptTokens > 0 && predicted != null && predicted > maxPromptTokens) {
      const err = new Error(`${label} request refused before send: the prompt is a predicted ${Math.round(predicted)} server tokens (bytes/3 estimate ${est} through a learnt ratio of ${calibration.ratio.toFixed(3)} over ${calibration.n} served calls), above ${envPrefix}MAX_PROMPT_TOKENS=${maxPromptTokens}; the transcript has to be shortened — re-sending cannot make it fit`);
      err.status = 413;
      err.contextTooSmall = true;
      err.code = 'transcript_too_large';
      err.est_tokens = Math.round(predicted);
      err.limit = maxPromptTokens;
      err.calibration = promptCalibration();
      throw err;
    }

    // Once per call, across retries: "thinking…" is a state, not an event stream.
    let reasoningNoted = false;
    const noteReasoning = typeof onReasoning === 'function'
      ? () => { if (!reasoningNoted) { reasoningNoted = true; onReasoning(); } }
      : undefined;
    // A </think> that nothing opened: reasoning happened (so "thinking…" is true, even late), and if
    // text had already been shown it was that reasoning — say so once, naming the knob.
    let leakedThisCall = false;
    const onOrphanClose = ({ leaked }) => {
      noteReasoning?.();
      if (leaked) { leakedThisCall = true; warnThinkLeak(); }
    };

    return getRunner().run(async (_attempt, sig) => {
      let data;
      try {
        data = onDelta
          ? await httpStream(`${baseUrl}/chat/completions`, { body, timeoutMs, apiKey, signal: sig, onDelta, onReasoning: noteReasoning, onOrphanClose, preopened: thinkPreopened, proxyUrl: proxyUrl(), label })
          : await httpJson(`${baseUrl}/chat/completions`, { method: 'POST', body, timeoutMs, apiKey, signal: sig, proxyUrl: proxyUrl(), label });
      } catch (e) {
        // Measured on the DGX (Ollama 0.32.15): a 9,144-token evaluation returns
        // 400 "... exceeds the available context size (4096)". That is the single most likely reason a
        // local model fails in production, and the raw message does not say what to do about it — so
        // say it here, once, at the point of failure. It stays a 400 (non-retryable): re-sending the
        // same oversized transcript four times cannot make it fit.
        if (/context (size|length)|exceeds the available context/i.test(e?.message || '')) {
          const hint = `The server is serving "${model}" with too small a context window for a PLE transcript. Raise it server-side (Ollama: OLLAMA_CONTEXT_LENGTH or a Modelfile \`PARAMETER num_ctx\`; vLLM: --max-model-len), or set ${envPrefix}NUM_CTX if this server honours a per-request override.`;
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
      // transcript — the caller surfaces the failure via stopReason instead. Inline <think> markup in
      // a string content is the same leak by another route: stripThink removes it.
      const raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      const text = stripThink(raw, { preopened: thinkPreopened });
      if (text !== raw && !leakedThisCall) warnThinkMarkup();
      // A streamed reply from a server that ignored include_usage has no usage at all. Zero would let the
      // token cap and the transcript cap never move, so estimate (the same bytes/3 unit as the prompt
      // backstop) and say so once. From the RAW content: the box generated the reasoning tokens too.
      const streamedNoUsage = !!onDelta && !data.usage;
      if (streamedNoUsage && !warnedNoStreamUsage) {
        warnedNoStreamUsage = true;
        console.warn(`${log} streamed reply carried no usage (server ignores stream_options.include_usage) — estimating tokens from bytes/3`);
      }
      const inputTokens = streamedNoUsage ? Math.round(predicted ?? est) : (data.usage?.prompt_tokens ?? 0);
      if (!streamedNoUsage) observePromptTokens(est, data.usage?.prompt_tokens);
      const outputTokens = streamedNoUsage ? Math.ceil(Buffer.byteLength(raw, 'utf8') / 3) : (data.usage?.completion_tokens ?? 0);
      const rawFinish = choice?.finish_reason ?? null;
      lastSeen = {
        model: typeof data.model === 'string' && data.model ? data.model : null,
        engine: engineOf(data.system_fingerprint),
        runtime: data.system_fingerprint || null,
        observed_at: new Date().toISOString(),
      };

      // THINK_PREOPENED and the reply never closed its reasoning block: by the operator's own
      // declaration, every byte of it was reasoning (most often it hit max_tokens mid-thought).
      // The same error services/ai.js raises for any empty reply (503 empty_reply, retryable by the
      // backend), thrown here because only here is it known to be reasoning-only. noRetry: not
      // re-generated here — four full generations on a shared box for one turn is the wrong place to retry.
      if (thinkPreopened && raw && !closesThink(raw)) {
        const err = emptyReplyError({ provider: name, stopReason: rawFinish, inputTokens, outputTokens, reasoningOnly: true });
        err.message += ` (${envPrefix}THINK_PREOPENED=1)`;
        err.noRetry = true;
        throw err;
      }

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
        // The per-request context override, ONLY when one was sent (body.options.num_ctx above), so
        // routes/evaluate.js records the decoding actually sent (§10.2 provenance.decoding.num_ctx).
        // Absent otherwise: a call without it returns exactly the shape it always did.
        ...(numCtx > 0 ? { numCtx } : {}),
      };
    }, { lane: laneFor(purpose), signal });
  }

  /**
   * Embed one string on the local box, via the same OpenAI-compatible surface (`POST /embeddings`).
   *
   * Kept beside chat rather than in a third provider file because it is the same host, the same key
   * and the same transport as chat — only the endpoint and the model differ. It deliberately does NOT
   * go through getRunner(): embedding is a sub-second call on every physician turn, and putting it in
   * the same queue as 150-second evaluations would let one scoring call stall every chat lookup behind it.
   */
  async function embed(text) {
    const { baseUrl, embedModel, apiKey } = cfg();
    if (!baseUrl) throw new Error(`${envPrefix}BASE_URL is not set (embed provider "${name}" requires it)`);
    if (!embedModel) throw new Error(`${envPrefix}EMBED_MODEL is not set (embed provider "${name}" requires it — the chat model is usually not an embedding model)`);
    const timeoutMs = Math.max(2000, parseInt(process.env[`${envPrefix}EMBED_TIMEOUT_MS`] || '15000', 10));
    const data = await httpJson(`${baseUrl}/embeddings`, {
      method: 'POST', body: { model: embedModel, input: text }, timeoutMs, apiKey, proxyUrl: proxyUrl(), label,
    });
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new Error(`${name} embeddings response carried no vector`);
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
      const data = await httpJson(`${root}/api/show`, { method: 'POST', body: { model }, timeoutMs: probeMs, apiKey, proxyUrl: proxyUrl(), label });
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
      return { checks: { [checkKey]: { status: 'down', error: !baseUrl ? `${envPrefix}BASE_URL not set` : `${envPrefix}MODEL not set` } } };
    }
    try {
      const data = await httpJson(`${baseUrl}/models`, { timeoutMs: probeMs, apiKey, proxyUrl: proxyUrl(), label });
      const served = (data?.data || []).map((m) => m.id);
      // An unenumerable /models proves NOTHING, so it cannot count as healthy: a reverse proxy or a
      // vLLM instance still registering answers 200 with {} or {"data":[]}, and treating that as `up`
      // green-lights precisely the failure this probe exists to catch — every /chat/completions 404s.
      if (!served.length) {
        return { checks: { [checkKey]: { status: 'down', error: '/models returned 200 but enumerated no models' } } };
      }
      // Reachable but NOT serving the pinned model is a real misconfiguration, not a warning: every
      // call would 404, and a silently-renamed model breaks the locked-version provenance guarantee.
      if (!served.includes(model)) {
        return { checks: { [checkKey]: { status: 'down', error: `model "${model}" not served (available: ${served.slice(0, 5).join(', ')})` } } };
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
        return { checks: { [checkKey]: { status: 'down', model, context_length: ctx, min_context: minContext,
          error: `served context ${ctx} is below the required minimum ${minContext} — a creditable PLE transcript (C3 >= 10,000 tokens) cannot be evaluated at this size` } } };
      }
      return { checks: { [checkKey]: { status: 'up', model, context_length: ctx ?? 'unknown', min_context: minContext } } };
    } catch (e) {
      return { checks: { [checkKey]: { status: 'down', error: e.message } } };
    }
  }

  // WHICH endpoint and model this instance would call, normalised for comparison — or null while
  // unconfigured. Used only by services/ai.js readiness() to compare the tutor with the evaluator
  // (CCME R3). Never reported anywhere: /health/deep is unauthenticated, and the box address is not
  // something it may print.
  function endpointKey() {
    const { baseUrl, model } = cfg();
    if (!baseUrl || !model) return null;
    let where = baseUrl.toLowerCase();
    try {
      const u = new URL(baseUrl);
      where = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;   // host case and a default port do not make a different box
    } catch { /* not a URL — compare the string as written */ }
    return `${where} ${model}`;
  }

  // This instance's configuration as the model manifest's live view reports it (services/manifest.js),
  // on the unauthenticated /health/deep: the base URL as present/absent ONLY — never the address — the
  // model id, the context override (null = not sent) and the thinking style, an unknown value as
  // 'invalid' rather than the 'none' a call falls back to, so a typo shows as drift.
  function configured() {
    const { baseUrl, model, numCtx } = cfg();
    return {
      base_url: baseUrl ? 'present' : 'absent',
      model: model || null,
      num_ctx: numCtx > 0 ? numCtx : null,
      thinking_style: parseThinkingStyle(process.env[`${envPrefix}THINKING_STYLE`]) ?? 'invalid',
    };
  }

  return {
    _resetDispatcher,
    name,
    call,
    supportsThinking,
    endpointKey,
    configured,
    lastSeen: () => (lastSeen ? { ...lastSeen } : null),
    ...(embeddings ? { embed } : {}),
    model: () => cfg().model,
    ...(embeddings ? { embedModel: () => cfg().embedModel } : {}),
    ready, servedContext,
    // Queue depth plus the learnt prompt-size calibration, so /health/deep shows the ratio the backstop
    // would use before anyone sets <prefix>MAX_PROMPT_TOKENS.
    stats: () => ({ ...getRunner().stats(), prompt_calibration: promptCalibration() }),
    LANE_FOR, laneFor, estimatePromptTokens, promptCalibration,
  };
}

module.exports = {
  createLocalProvider,
  // Re-exported from lib/think-markup.js — one definition, shared with the probe/quality harness.
  stripThink, createThinkFilter, closesThink, flagOn, thinkingEnabled,
  THINKING_STYLES, LANE_FOR, laneFor, estimatePromptTokens, isRetryable,
  _resetDispatcher,
};
