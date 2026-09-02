// The single AI seam for RIMPL. Every model call in every route goes through callAI().
//
// Routes declare WHAT THEY ARE (purpose), never which vendor they want — the vendor is a deployment
// decision, so the routing policy lives here in one place. That is what makes a permanent hybrid
// (chat on the local DGX, PIS-7 scoring on Claude) a first-class supported configuration rather
// than a fork in the code. See docs/LOCAL-MODEL-ROADMAP.md.
//
// Resolution order, per call:
//   app_settings.ai_provider_<purpose>  →  AI_PROVIDER_<PURPOSE>  →  AI_PROVIDER  →  'anthropic'
//
// Resolved PER CALL, not at module load, so a cutover is a superadmin toggle (or an env change) plus
// the next request — no redeploy, no restart. The database layer lives INSIDE providerNameFor()
// rather than beside it, deliberately: shadow.js asks providerNameFor('evaluate') to decide whether
// the shadow model differs from the served one, and resolving the override anywhere else would leave
// that guard reading env while traffic followed the database — the shadow arm would then score with
// the very model it is supposed to be compared against.
const anthropic = require('./providers/anthropic');
const local = require('./providers/local');
const openaiEmbed = require('./providers/openai-embed');
const settings = require('./provider-settings');
const { isQueueFull, isAborted, isTooLarge } = require('../lib/ai-errors');

const PROVIDERS = { anthropic, local };

// 'criteria' = the C1–C6 classifier, 'discuss' = the auditor calibration tutor.
const PURPOSES = ['chat', 'evaluate', 'criteria', 'discuss'];

// Embeddings are a SEPARATE registry, not a fifth entry in PURPOSES. Anthropic has no embeddings
// API, so folding 'embed' into the chat purposes would let a config name a provider that cannot
// serve it, and would make activeProviders()/modelsByPurpose() report a chat model for a purpose
// that never uses one. Same switch semantics, different set of valid answers.
const EMBED_PROVIDERS = { openai: openaiEmbed, local };
const EMBED_PURPOSE = 'embed';

// Every purpose whose override this process reads from the database.
const SETTING_PURPOSES = [...PURPOSES, EMBED_PURPOSE];

function envProviderName(purpose, fallbackEnv, dflt) {
  const perPurpose = purpose ? process.env[`AI_PROVIDER_${String(purpose).toUpperCase()}`] : undefined;
  return String(perPurpose || process.env[fallbackEnv] || dflt).trim().toLowerCase();
}

// SYNCHRONOUS by contract — shadow.js and /health/deep both call it outside an async resolution
// step. The database value therefore comes from provider-settings' cache, which fails soft to env.
function providerNameFor(purpose) {
  return settings.overrideFor(purpose) || envProviderName(purpose, 'AI_PROVIDER', 'anthropic');
}

function embedProviderName() {
  return settings.overrideFor(EMBED_PURPOSE) || envProviderName(EMBED_PURPOSE, 'EMBED_PROVIDER', 'openai');
}

// Fail loudly on an unknown name. Silently falling back to Anthropic on a typo would mean paying
// cloud rates while believing you were on-prem — and, for `evaluate`, scoring under a model nobody
// intended. This is also why the database layer above cannot introduce a default of its own.
function lookup(registry, name, whence) {
  const provider = registry[name];
  if (!provider) {
    throw new Error(`Unknown AI provider "${name}" (from ${whence}). Valid: ${Object.keys(registry).join(', ')}`);
  }
  return provider;
}

function providerFor(purpose) {
  const name = providerNameFor(purpose);
  const whence = `${purpose ? `app_settings.ai_provider_${purpose} / AI_PROVIDER_${String(purpose).toUpperCase()} / ` : ''}AI_PROVIDER`;
  return lookup(PROVIDERS, name, whence);
}

// ---------------------------------------------------------------------------------------------
// Chat fail-over — DORMANT. Ships with CHAT_FAILOVER_PROVIDER unset, which changes nothing anywhere.
//
// CREC decision pending: research transcripts must not fall back to a cloud model without an ethics
// amendment. The hook exists so that decision, once taken, is an env change rather than a code change.
//
// When set, a `chat` turn whose PRIMARY provider is DOWN is retried ONCE on the named provider, with
// the SAME de-identified request, and the result is marked — `provider` is the one that answered,
// `failed_over_from` the one that did not — so the backend can record which model wrote the turn.
//
// Only `chat`, only the resolved (not pinned) path, only DOWN-class errors:
//   * evaluate / criteria / discuss / shadow NEVER fail over. They queue and retry, and PIS-7 scoring
//     relocating to another model mid-cohort is the one outcome this file exists to prevent.
//   * a pinned call (routes/chat.js's citation retry) never fails over: the pin exists so that one
//     physician turn is never written half by each model.
//   * queue_full is OUR lane bound, not a dead provider; aborted means nobody is waiting for the
//     answer; 413 / transcript_too_large cannot shrink by changing vendor; any other 4xx is a request
//     the provider rejected, which a second provider would reject too.
//   * a configuration error (LOCAL_AI_BASE_URL unset) is not DOWN either. A misconfigured box must
//     fail loudly, not quietly serve the cloud while an operator believes traffic is on-prem.
const FAILOVER_PURPOSES = new Set(['chat']);

// Transport-level "nobody is answering", wherever the code sits in the cause chain: Node's fetch
// rejects with TypeError('fetch failed') and puts the real code on .cause.
const DOWN_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function errorCode(err) {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (typeof e.code === 'string' && e.code) return e.code;
  }
  return null;
}

// The DOWN class: connection refused / reset / unresolvable, our own client deadline
// (AbortSignal.timeout → DOMException 'TimeoutError', tagged `localTimeout` by providers/local.js), or
// an HTTP 5xx from the provider itself. Everything else propagates to the route unchanged.
function isProviderDown(err) {
  if (!err || isQueueFull(err) || isAborted(err) || isTooLarge(err)) return false;
  if (err.localTimeout === true || err.name === 'TimeoutError') return true;
  if (typeof err.status === 'number') return err.status >= 500;
  const code = errorCode(err);
  return code != null && DOWN_CODES.has(code);
}

// For the ONE log line a fail-over writes. Never the message: a provider error may quote the
// server's response body, and a transcript fragment must not end up in a log line.
function downReason(err) {
  if (err.localTimeout === true || err.name === 'TimeoutError') return 'timeout';
  if (typeof err.status === 'number') return `HTTP ${err.status}`;
  return errorCode(err) || err.name || 'error';
}

// The fail-over target for a primary, or null when the hook is dormant (env unset) or would point
// back at the same provider. An UNKNOWN name throws on the first chat turn, with the primary healthy,
// rather than surfacing for the first time during the outage it was meant to cover.
function failoverProviderFor(primary) {
  const name = String(process.env.CHAT_FAILOVER_PROVIDER || '').trim().toLowerCase();
  if (!name) return null;
  const provider = lookup(PROVIDERS, name, 'CHAT_FAILOVER_PROVIDER');
  return provider.name === primary.name ? null : provider;
}

/**
 * @param {object}   opts
 * @param {string}   opts.purpose  one of PURPOSES — selects the provider
 * @param {string}   [opts.provider] PIN to this provider, skipping resolution. For a route that makes
 *                   more than one call for ONE user-visible turn (routes/chat.js retries when a
 *                   citation is missing): pass the `provider` the first result carried, so a toggle
 *                   flipped between the two calls cannot have one physician turn produced half by
 *                   Claude and half by the DGX — an outcome `messages` has no column to record.
 * @param {string}   opts.systemPrompt
 * @param {Array}    opts.messages  [{role, content}] — MUST already be de-identified by the caller
 * @param {number}   [opts.maxTokens]
 * @param {number}   [opts.temperature]
 * @param {AbortSignal} [opts.signal]  fires when the caller has gone away (lib/request-signal.js).
 *                   A queued call leaves the queue; an in-flight one is cancelled at the transport.
 *                   Rejections carry `aborted: true` and are never retried.
 * @returns {Promise<{text, inputTokens, outputTokens, tokenCount, stopReason, provider, model}>}
 *                   plus `failed_over_from` (the primary's name) ONLY when the dormant chat fail-over
 *                   hook answered from CHAT_FAILOVER_PROVIDER — absent on every ordinary call.
 * @throws QueueFullError `{code:'queue_full', status:503, lane, retryAfterMs}` when the provider's
 *                   lane for this purpose is full — nothing was queued (providers/runtime.js).
 */
async function callAI({ purpose, provider: pinned, systemPrompt, messages, maxTokens, temperature, signal }) {
  if (purpose && !PURPOSES.includes(purpose)) {
    throw new Error(`Unknown AI purpose "${purpose}". Valid: ${PURPOSES.join(', ')}`);
  }
  let provider;
  if (pinned) {
    provider = lookup(PROVIDERS, String(pinned).trim().toLowerCase(), 'a pinned provider');
  } else {
    // Cold cache blocks here exactly once per process; afterwards this is a cache read with a
    // background refresh. See provider-settings.ensureFresh.
    await settings.ensureFresh(SETTING_PURPOSES);
    provider = providerFor(purpose);
  }
  const request = { systemPrompt, messages, maxTokens, temperature, purpose, signal };
  const failover = !pinned && FAILOVER_PURPOSES.has(purpose) ? failoverProviderFor(provider) : null;
  if (!failover) return callWith(provider, request);

  try {
    return await callWith(provider, request);
  } catch (err) {
    if (!isProviderDown(err)) throw err;
    console.warn(`[ai] chat fail-over: primary "${provider.name}" is down (${downReason(err)}) — retrying once on "${failover.name}"`);
    // The SAME request object the primary received: nothing is rebuilt here, so nothing can reach the
    // second provider that did not already reach the first — the de-identification upstream in the
    // route is the only thing that ever produced `messages`.
    const result = await callWith(failover, request);
    return { ...result, failed_over_from: provider.name };
  }
}

/**
 * Call a provider BY NAME, bypassing purpose routing.
 *
 * For infrastructure that is inherently about a specific vendor — today only the shadow evaluator,
 * whose entire job is to run the model that ISN'T serving. Routes must keep using callAI(purpose):
 * naming a vendor in a route is what this design exists to prevent.
 */
async function callProvider({ provider: name, purpose, systemPrompt, messages, maxTokens, temperature, signal }) {
  const provider = lookup(PROVIDERS, String(name || '').trim().toLowerCase(), 'an explicit provider name');
  return callWith(provider, { systemPrompt, messages, maxTokens, temperature, purpose, signal });
}

// `purpose` and `signal` travel to the provider deliberately: the local provider picks its queue lane
// from the purpose (a chat turn must never wait behind an evaluation) and cancels at the transport
// from the signal. A provider that has neither concept (Anthropic) simply ignores both keys.
async function callWith(provider, { systemPrompt, messages, maxTokens, temperature, purpose, signal }) {
  const result = await provider.call({ systemPrompt, messages, maxTokens, temperature, purpose, signal });
  // `provider` + `model` travel WITH the result, deliberately. A module-level MODEL constant is only
  // correct while exactly one model exists; under a hybrid it silently mislabels which system
  // produced a score (§10.2 provenance) and which rate to bill it at.
  return { ...result, provider: provider.name, model: result.model || provider.model() };
}

/**
 * Embed one string for RAG retrieval.
 *
 * Routed through the same switch as everything else so "all AI runs on-premise" can actually become
 * true — before this, services/rag.js called api.openai.com directly and no configuration could
 * move it. Throws on failure; ragLookup decides whether a miss is fatal (it is not).
 */
async function embedText(text) {
  await settings.ensureFresh(SETTING_PURPOSES);
  const name = embedProviderName();
  const provider = lookup(EMBED_PROVIDERS, name, `app_settings.ai_provider_embed / AI_PROVIDER_EMBED / EMBED_PROVIDER`);
  if (typeof provider.embed !== 'function') {
    throw new Error(`Provider "${name}" cannot embed. Valid embedding providers: ${Object.keys(EMBED_PROVIDERS).join(', ')}`);
  }
  const vector = await provider.embed(text);

  // The corpus in `documents` was embedded at ONE dimension and match_documents compares against
  // vector(1536). A different embedding model returns a different-length vector: pgvector rejects a
  // length mismatch, but a model that happens to match the length while placing text in a completely
  // different space would return confident nonsense instead. Fail here, where the cause is legible.
  const want = parseInt(process.env.RAG_EMBED_DIM || '1536', 10);
  if (Array.isArray(vector) && Number.isFinite(want) && vector.length !== want) {
    throw new Error(`Embedding provider "${name}" returned ${vector.length} dimensions; the document corpus is ${want}. Re-embed the corpus before switching, or set RAG_EMBED_DIM.`);
  }
  return vector;
}

// Distinct providers actually reachable under the current config — drives /health/deep, so a
// deployment only probes (and only reports degraded for) the vendors it truly depends on.
function activeProviders() {
  return [...new Set(PURPOSES.map(providerNameFor))];
}

// The provider a purposeless caller would get. NOTE this reads only the global layers — it is
// structurally blind to the per-purpose overrides, so it must NOT be used to describe what a
// deployment runs.
function defaultProvider() {
  return providerFor(null);
}

// The model actually behind each purpose. This is the honest answer to "what is this deployment
// running": with AI_PROVIDER_*=local and AI_PROVIDER unset, defaultProvider() still says anthropic,
// which would have /health/deep report claude-sonnet-4-6 on a box where every call goes to the DGX.
// Reads the SAME resolution as callAI (database included), or the provenance it reports is a lie.
function modelsByPurpose() {
  const out = {};
  for (const purpose of PURPOSES) {
    const name = providerNameFor(purpose);
    const provider = PROVIDERS[name];
    out[purpose] = provider ? { provider: name, model: provider.model() } : { provider: name, model: null };
  }
  const embedName = embedProviderName();
  const embedProvider = EMBED_PROVIDERS[embedName];
  out[EMBED_PURPOSE] = { provider: embedName, model: embedProvider ? embedProvider.embedModel?.() ?? null : null };
  return out;
}

// The providers /health/deep must probe: every ACTIVE one, plus the chat fail-over target when one is
// configured. anthropic.ready() is a key-presence check, so a missing ANTHROPIC_API_KEY on a box that
// would fail over to it shows up here — before the outage it was meant to cover, not during it. The
// target is probed, not made active: routing, the `providers` report and the queue report ignore it.
function providersToProbe() {
  const names = new Set(activeProviders());
  const failover = String(process.env.CHAT_FAILOVER_PROVIDER || '').trim().toLowerCase();
  if (failover) names.add(failover);
  return [...names];
}

// Aggregated readiness across every provider that must be probed (see providersToProbe). Never
// throws — a probe failure is a `down` check, not a 500.
async function readiness() {
  const checks = {};
  // Resolve from the database first so /health/deep probes what traffic will ACTUALLY hit. Probing
  // the env-resolved provider on a DB-switched box reports the wrong vendor as healthy.
  await settings.ensureFresh(SETTING_PURPOSES).catch(() => {});
  for (const name of providersToProbe()) {
    const provider = PROVIDERS[name];
    if (!provider) { checks[`${name}_provider`] = { status: 'down', error: `unknown provider "${name}"` }; continue; }
    try {
      const r = await Promise.resolve(provider.ready());
      Object.assign(checks, r?.checks || {});
    } catch (e) {
      checks[`${name}_provider`] = { status: 'down', error: e?.message || String(e) };
    }
  }
  return checks;
}

/**
 * Probe ONE named provider, whether or not it currently serves anything.
 *
 * readiness() above deliberately probes only the ACTIVE providers, which is right for /health/deep —
 * a cloud-only box should not be reported degraded for an on-prem server it never calls. But it is
 * exactly wrong for the question asked immediately BEFORE a switch: "is the thing I am about to
 * switch to able to serve?" By definition that provider is not active yet.
 *
 * Returns a VERDICT, not just checks. The caller is a gate, and pushing the fit/unfit judgement out
 * to every caller is how two callers end up disagreeing about what `context_length: 'unknown'` means.
 *
 * UNKNOWN IS UNFIT. A server that cannot be enumerated proves nothing, and the whole reason this
 * exists is that an unfit server currently switches successfully and then fails one physician at a
 * time. Optimism here has a known cost and no benefit.
 */
async function probeProvider(name, purpose = 'chat') {
  const registry = purpose === EMBED_PURPOSE ? EMBED_PROVIDERS : PROVIDERS;
  const provider = registry[name];
  if (!provider) {
    return { provider: name, purpose, fit: false, code: 'unknown_provider',
      reason: `"${name}" is not a known ${purpose === EMBED_PURPOSE ? 'embedding ' : ''}provider`, checks: {} };
  }

  let checks = {};
  try {
    checks = (await Promise.resolve(provider.ready?.() ?? {}))?.checks || {};
  } catch (e) {
    return { provider: name, purpose, fit: false, code: 'probe_failed', reason: e?.message || String(e), checks: {} };
  }

  const down = Object.entries(checks).find(([, c]) => c?.status !== 'up');
  if (down) {
    // ready() already distinguishes "too small a context" from "unreachable", so pass its judgement
    // through rather than re-deriving it here — but pass the NUMBERS through as fields too. The
    // caller renders "measured X, needs Y" from `measured`/`required`; leaving them null while the
    // prose carried both numbers made the refusal unreadable to everything except a human.
    const [, c] = down;
    const tooSmall = typeof c?.context_length === 'number';
    return { provider: name, purpose, fit: false,
      code: tooSmall ? 'context_too_small' : 'provider_down',
      reason: c?.error || 'provider reported not ready',
      measured: tooSmall ? c.context_length : null,
      required: typeof c?.min_context === 'number' ? c.min_context : null,
      checks };
  }

  // Embedding dimension is not discoverable any other way — no endpoint reports it, so the only
  // honest probe is to embed something and measure what comes back. Kept to one short string: this
  // runs on a deliberate switch, not on a request path.
  if (purpose === EMBED_PURPOSE) {
    if (typeof provider.embed !== 'function') {
      return { provider: name, purpose, fit: false, code: 'cannot_embed',
        reason: `provider "${name}" cannot embed`, checks };
    }
    const want = parseInt(process.env.RAG_EMBED_DIM || '1536', 10);
    let got;
    try {
      got = (await provider.embed('probe'))?.length ?? null;
    } catch (e) {
      return { provider: name, purpose, fit: false, code: 'probe_failed', reason: e?.message || String(e), checks };
    }
    if (got !== want) {
      return { provider: name, purpose, fit: false, code: 'embed_dim_mismatch',
        reason: `provider "${name}" returns ${got} dimensions; the document corpus is ${want}. Re-embed the corpus before switching, or set RAG_EMBED_DIM.`,
        measured: got, required: want, checks };
    }
    return { provider: name, purpose, fit: true, code: null, reason: null, measured: got, required: want, checks };
  }

  const ctx = Object.values(checks).map((c) => c?.context_length).find((v) => v != null);
  const min = Object.values(checks).map((c) => c?.min_context).find((v) => v != null);
  return { provider: name, purpose, fit: true, code: null, reason: null,
    measured: typeof ctx === 'number' ? ctx : null,
    required: typeof min === 'number' ? min : null, checks };
}

// Where the current routing came from (database vs env) and how stale it is. A box that BELIEVES it
// is superadmin-controlled but is silently running on env should be visible, not inferred.
function providerSettingsStatus() {
  return { ...settings.status(), evaluator_locked_at: settings.evaluatorLockedAt() };
}

module.exports = {
  callAI, callProvider, embedText,
  activeProviders, defaultProvider, modelsByPurpose, providerNameFor, embedProviderName,
  providerSettingsStatus, readiness, probeProvider, isProviderDown,
  PURPOSES, PROVIDERS, EMBED_PROVIDERS, EMBED_PURPOSE, SETTING_PURPOSES,
};
