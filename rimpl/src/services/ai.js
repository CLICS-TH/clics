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
const localTutor = require('./providers/local-tutor');
const openaiEmbed = require('./providers/openai-embed');
const settings = require('./provider-settings');
const { isQueueFull, isAborted, isTooLarge } = require('../lib/ai-errors');

// `local` is the on-prem EVALUATOR (DeepSeek); `local-tutor` is the on-prem tutor model, a second
// instance of the same transport on its own endpoint (providers/local-tutor.js, CCME R3). Each key
// must equal the provider's own `name`: results, provenance and bills are stamped with that name.
const PROVIDERS = { anthropic, local, 'local-tutor': localTutor };

// The routing POLICY (purposes, which provider may serve which, which purposes may fail over) is data in
// lib/provider-policy.js, package-free, so the model manifest (lib/manifest.js) records the very lists
// this file routes with. 'criteria' = the C1–C6 classifier, 'discuss' = the auditor calibration tutor.
const {
  PURPOSES, PROVIDER_NAMES, EMBED_PROVIDER_NAMES, PROVIDER_PURPOSES, servesPurpose,
  FAILOVER_PURPOSES: FAILOVER_PURPOSE_LIST, DEFAULT_PROVIDER, DEFAULT_EMBED_PROVIDER,
} = require('../lib/provider-policy');

// Embeddings are a SEPARATE registry, not a fifth entry in PURPOSES. Anthropic has no embeddings
// API, so folding 'embed' into the chat purposes would let a config name a provider that cannot
// serve it, and would make activeProviders()/modelsByPurpose() report a chat model for a purpose
// that never uses one. Same switch semantics, different set of valid answers.
const EMBED_PROVIDERS = { openai: openaiEmbed, local };
const EMBED_PURPOSE = 'embed';

// The two registries and the policy's name lists must agree, or the manifest would record a provider set
// this file does not route with. Fails at boot, where every test catches it.
for (const [label, registry, names] of [['PROVIDERS', PROVIDERS, PROVIDER_NAMES], ['EMBED_PROVIDERS', EMBED_PROVIDERS, EMBED_PROVIDER_NAMES]]) {
  if (Object.keys(registry).join() !== names.join()) {
    throw new Error(`services/ai.js ${label} (${Object.keys(registry).join(', ')}) disagrees with lib/provider-policy.js (${names.join(', ')})`);
  }
}

// Every purpose whose override this process reads from the database.
const SETTING_PURPOSES = [...PURPOSES, EMBED_PURPOSE];

function envProviderName(purpose, fallbackEnv, dflt) {
  const perPurpose = purpose ? process.env[`AI_PROVIDER_${String(purpose).toUpperCase()}`] : undefined;
  return String(perPurpose || process.env[fallbackEnv] || dflt).trim().toLowerCase();
}

// SYNCHRONOUS by contract — shadow.js and /health/deep both call it outside an async resolution
// step. The database value therefore comes from provider-settings' cache, which fails soft to env.
function providerNameFor(purpose) {
  return settings.overrideFor(purpose) || envProviderName(purpose, 'AI_PROVIDER', DEFAULT_PROVIDER);
}

function embedProviderName() {
  return settings.overrideFor(EMBED_PURPOSE) || envProviderName(EMBED_PURPOSE, 'EMBED_PROVIDER', DEFAULT_EMBED_PROVIDER);
}

// PROVIDER_PURPOSES / servesPurpose (lib/provider-policy.js): `local-tutor` is the TUTOR and may serve
// only chat and discuss (CCME R3: the evaluator must be a distinct artifact from the tutor), and
// `shadow` obeys the `evaluate` rule. Enforced HERE, loudly: the call throws and readiness() reports
// the purpose down, exactly like an unknown provider name.
function assertServes(provider, purpose, whence) {
  if (!servesPurpose(provider.name, purpose)) {
    throw new Error(`AI provider "${provider.name}" (from ${whence}) cannot serve "${purpose}" — it serves only ${PROVIDER_PURPOSES[provider.name].join(', ')}`);
  }
  return provider;
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
  return assertServes(lookup(PROVIDERS, name, whence), purpose, whence);
}

// Resolve the provider NAME for a purpose — database layer included, validated, nothing called. For a
// route that has to know the provider BEFORE its first call: routes/evaluate.js chooses the prompt and
// the scoring rule from it, then PINS every call to it (`callAI({ provider })`), so a toggle flipped
// mid-evaluation cannot have one provider's prompt scored by another, or a second consistency call
// answered by a different model than the first.
async function resolveProviderName(purpose) {
  await settings.ensureFresh(SETTING_PURPOSES);
  return providerFor(purpose).name;
}

// Does the provider NAMED here honour a `thinking` request? Asked by routes/chat.js after a call, of
// the provider that actually ANSWERED it (a fail-over, or a toggle flipped between the question below
// and the call, can make that a different one), so a turn is never recorded as thinking on a provider
// that ignores the flag. A provider says so itself (providers/local-factory.js supportsThinking: its
// <PREFIX>THINKING_STYLE is set); one that has no such method does not: Anthropic ignores `thinking`
// altogether (providers/anthropic.js), so it is false. An unknown name is false, never a throw: this is
// a description of a call that already happened.
function supportsThinking(name) {
  const provider = PROVIDERS[String(name || '').trim().toLowerCase()];
  return typeof provider?.supportsThinking === 'function' && provider.supportsThinking() === true;
}

// The same question BEFORE a call: resolve the provider for `purpose` exactly as an unpinned callAI
// would (database layer included, validated — resolveProviderName above), then ask it. routes/chat.js
// applies the fast/deep router's tier (services/router.js) only when this is true, so a deployment
// whose chat provider cannot think sends byte-identical requests whether the router is on or off.
async function providerSupportsThinking(purpose) {
  return supportsThinking(await resolveProviderName(purpose));
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
const FAILOVER_PURPOSES = new Set(FAILOVER_PURPOSE_LIST);

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
// `reasoning_only` (providers/local-factory.js, THINK_PREOPENED) is not DOWN either: the box answered,
// with nothing but reasoning. A second vendor would not make the first one's template close its block.
function isProviderDown(err) {
  if (!err || isQueueFull(err) || isAborted(err) || isTooLarge(err) || err.code === 'reasoning_only') return false;
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
// `onDelta` (optional, chat only in practice) streams the reply — providers/*.js call(). Once any text has
// been handed out, the turn is committed to the provider that produced it: no fail-over.
//
// `thinking` (optional): true/false or { enabled, budget? } — ask a reasoning model to think, or not.
// Forwarded only when given; a provider sends it only if its server is configured for it
// (providers/local-factory.js <prefix>THINKING_STYLE, default none). Anthropic ignores it.
// `onReasoning()` (optional, streamed calls only): called once, with nothing, when the reply's
// reasoning starts arriving, so a caller can show "thinking…". The reasoning text never leaves the
// provider. It does NOT commit the turn the way onDelta does: no reply text has been shown yet.
// routes/chat.js passes both only with the fast/deep router on (`router_enabled`): `thinking` when the
// chat provider honours it (providerSupportsThinking), `onReasoning` on a streamed turn.
async function callAI({ purpose, provider: pinned, systemPrompt, messages, maxTokens, temperature, signal, onDelta, thinking, onReasoning }) {
  if (purpose && !PURPOSES.includes(purpose)) {
    throw new Error(`Unknown AI purpose "${purpose}". Valid: ${PURPOSES.join(', ')}`);
  }
  let provider;
  if (pinned) {
    provider = assertServes(lookup(PROVIDERS, String(pinned).trim().toLowerCase(), 'a pinned provider'), purpose, 'a pinned provider');
  } else {
    // Cold cache blocks here exactly once per process; afterwards this is a cache read with a
    // background refresh. See provider-settings.ensureFresh.
    await settings.ensureFresh(SETTING_PURPOSES);
    provider = providerFor(purpose);
  }
  let emitted = false;
  const request = {
    systemPrompt, messages, maxTokens, temperature, purpose, signal,
    onDelta: onDelta ? (t) => { emitted = true; onDelta(t); } : undefined,
    thinking, onReasoning,
  };
  const failover = !pinned && FAILOVER_PURPOSES.has(purpose) ? failoverProviderFor(provider) : null;
  if (!failover) return callWith(provider, request);

  try {
    return await callWith(provider, request);
  } catch (err) {
    if (!isProviderDown(err) || emitted) throw err;
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
//
// Still subject to the purpose guard (PROVIDER_PURPOSES via servesPurpose): naming the provider skips
// ROUTING, not the rule about what it may do. services/shadow.js refuses such a target before it gets
// here; this is the backstop if anything ever calls past that check.
async function callProvider({ provider: name, purpose, systemPrompt, messages, maxTokens, temperature, signal, thinking, onReasoning }) {
  const provider = assertServes(lookup(PROVIDERS, String(name || '').trim().toLowerCase(), 'an explicit provider name'), purpose, 'an explicit provider name');
  return callWith(provider, { systemPrompt, messages, maxTokens, temperature, purpose, signal, thinking, onReasoning });
}

// `purpose` and `signal` travel to the provider deliberately: the local provider picks its queue lane
// from the purpose (a chat turn must never wait behind an evaluation) and cancels at the transport
// from the signal. Anthropic has no lanes, but it uses both: the signal cancels a queued or in-flight
// call, and the purpose marks an evaluation for its late-retry cutoff.
//
// The optional fields are spread in only when present, so a call that uses none of them reaches the
// provider with exactly the arguments it always had.
async function callWith(provider, { systemPrompt, messages, maxTokens, temperature, purpose, signal, onDelta, thinking, onReasoning }) {
  const result = await provider.call({
    systemPrompt, messages, maxTokens, temperature, purpose, signal,
    ...(onDelta ? { onDelta } : {}),
    ...(thinking != null ? { thinking } : {}),
    ...(typeof onReasoning === 'function' ? { onReasoning } : {}),
  });
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
/**
 * Is retrieval switched on? (app_settings.rag_enabled, 0/1.)
 *
 * DEFAULTS OFF when the row is absent, and that default is load-bearing rather than cautious.
 * Retrieval embeds every physician turn through the `embed` provider, which on this deployment is
 * a DIFFERENT VENDOR from the one serving chat. The revised CREC082 submission set declares "local
 * open-weight AI and no commercial external AI/API for research transcripts" in four attachments,
 * so whether that call happens has to be a switch an auditor can read — not a side effect of
 * whether a table happens to be empty.
 *
 * It was a side effect of exactly that until 2026-09-05: `documents` holds 0 rows in production, so
 * every chat turn paid an api.openai.com round trip to search nothing. The text was de-identified
 * first (routes/chat.js strips before calling), so this was a conformance gap rather than a leak —
 * but it bought nothing at all.
 */
async function ragEnabled() {
  await settings.ensureFresh(SETTING_PURPOSES).catch(() => {});
  return (settings.numberFor('rag_enabled') ?? 0) === 1;
}

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
// Which providers /health/deep must probe, and where to look each one up.
//
// The embed provider was missing here until 2026-09-05, and it is a DIFFERENT VENDOR: with
// ai_provider_embed=openai the deployment talks to api.openai.com on every chat turn while
// /health/deep reported only anthropic and supabase. Whether OPENAI_API_KEY was even set was not
// answerable from outside — and that question decides whether retrieval is quietly shipping text to
// a third party or quietly throwing. Neither state was visible. openai-embed has always exported a
// ready(); nothing called it.
//
// Returns [name, provider] pairs because embed providers live in their own registry (EMBED_PROVIDERS):
// 'openai' is not in PROVIDERS at all, so probing it by name alone reported `unknown provider`.
//
// `includeEmbed` is the caller's answer to "is retrieval switched on?". When it is OFF, ragLookup
// returns before ever reaching the embed provider, so an unset OPENAI_API_KEY degrades nothing and
// reporting it `down` would take the whole endpoint to 503 over a vendor no request touches. A check
// that cries wolf is worse than no check — it is the reason the prompt-provenance warning next door
// went unread. Probe the embed lane exactly when it is part of the serving path.
function providersToProbe({ includeEmbed } = {}) {
  const found = new Map();
  const add = (name, registry) => {
    const n = String(name || '').trim().toLowerCase();
    if (n && !found.has(n)) found.set(n, registry[n] || null);
  };
  for (const n of activeProviders()) add(n, PROVIDERS);
  const failover = String(process.env.CHAT_FAILOVER_PROVIDER || '').trim().toLowerCase();
  if (failover) add(failover, PROVIDERS);
  // Last, so a provider serving BOTH chat and embeddings keeps its chat registry entry — local is in
  // both maps, and its ready() there is the one that checks the served context.
  if (includeEmbed) add(embedProviderName(), EMBED_PROVIDERS);
  return [...found.entries()];
}

// Aggregated readiness across every provider that must be probed (see providersToProbe). Never
// throws — a probe failure is a `down` check, not a 500.
async function readiness() {
  const checks = {};
  // Resolve from the database first so /health/deep probes what traffic will ACTUALLY hit. Probing
  // the env-resolved provider on a DB-switched box reports the wrong vendor as healthy.
  await settings.ensureFresh(SETTING_PURPOSES).catch(() => {});
  // Sync read: ensureFresh above has just warmed the cache, and ragEnabled() would refresh it twice.
  const includeEmbed = (settings.numberFor('rag_enabled') ?? 0) === 1;
  // A purpose routed to a provider that may not serve it fails EVERY call (providerFor throws), so the
  // deployment is not ready, whatever that provider's own probe says. See PROVIDER_PURPOSES.
  for (const purpose of PURPOSES) {
    const name = providerNameFor(purpose);
    if (!servesPurpose(name, purpose)) {
      checks[`${purpose}_routing`] = { status: 'down', error: `"${name}" cannot serve "${purpose}" — it serves only ${PROVIDER_PURPOSES[name].join(', ')}` };
    }
  }
  // CCME R3: the evaluator must be a distinct model artifact from the tutor. If the tutor instance is
  // configured to the SAME endpoint and the SAME model as the evaluator, the split is nominal. A
  // WARNING, not a failure (routes/health.js counts `warn` as serving): nothing is broken, the
  // deployment is just not doing what its configuration claims. Two caveats it cannot get past:
  // equal names prove nothing about weights (ready() proves reachability, not identity), and two
  // gateways in front of one checkpoint compare as different. It is a tripwire, not a proof.
  // Neither URL is reported — /health/deep is unauthenticated.
  try {
    const evaluatorAt = local.endpointKey?.();
    const tutorAt = localTutor.endpointKey?.();
    if (evaluatorAt && tutorAt && evaluatorAt === tutorAt) {
      checks.r3_distinct_models = { status: 'warn',
        warning: 'local-tutor is configured to the same endpoint and model as local (the evaluator): LOCAL_TUTOR_AI_BASE_URL + LOCAL_TUTOR_AI_MODEL equal LOCAL_AI_BASE_URL + LOCAL_AI_MODEL, so the tutor and the evaluator are one model artifact (CCME R3 requires two)' };
    }
  } catch { /* a comparison that cannot be made is not a finding */ }
  for (const [name, provider] of providersToProbe({ includeEmbed })) {
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
  // Refused before any probe: a provider that may not serve this purpose is unfit however healthy it is.
  if (!servesPurpose(name, purpose)) {
    return { provider: name, purpose, fit: false, code: 'purpose_not_served',
      reason: `"${name}" cannot serve "${purpose}" — it serves only ${PROVIDER_PURPOSES[name].join(', ')}`, checks: {} };
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

// Warm the settings cache (fail-soft, like readiness()) for a reader that reports the routing without
// making a call: GET /manifest (routes/manifest.js).
async function ensureFreshSettings() {
  await settings.ensureFresh(SETTING_PURPOSES).catch(() => {});
}

// Where the current routing came from (database vs env) and how stale it is. A box that BELIEVES it
// is superadmin-controlled but is silently running on env should be visible, not inferred.
function providerSettingsStatus() {
  return { ...settings.status(), evaluator_locked_at: settings.evaluatorLockedAt() };
}

module.exports = {
  callAI, callProvider, embedText, ragEnabled, resolveProviderName, providerSupportsThinking, supportsThinking,
  activeProviders, defaultProvider, modelsByPurpose, providerNameFor, embedProviderName,
  providerSettingsStatus, ensureFreshSettings, readiness, probeProvider, isProviderDown, servesPurpose,
  PURPOSES, PROVIDERS, EMBED_PROVIDERS, EMBED_PURPOSE, SETTING_PURPOSES, PROVIDER_PURPOSES,
};
