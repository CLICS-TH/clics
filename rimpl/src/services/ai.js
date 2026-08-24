// The single AI seam for RIMPL. Every model call in every route goes through callAI().
//
// Routes declare WHAT THEY ARE (purpose), never which vendor they want — the vendor is a deployment
// decision, so the routing policy lives here in one place. That is what makes a permanent hybrid
// (chat on the local DGX, PIS-7 scoring on Claude) a first-class supported configuration rather
// than a fork in the code. See docs/LOCAL-MODEL-ROADMAP.md.
//
// Resolution order, per call:  AI_PROVIDER_<PURPOSE>  →  AI_PROVIDER  →  'anthropic'
// Resolved PER CALL, not at module load, so a rollback is an env change plus the next request —
// no redeploy, no restart.
const anthropic = require('./providers/anthropic');
const local = require('./providers/local');

const PROVIDERS = { anthropic, local };

// 'criteria' = the C1–C6 classifier, 'discuss' = the auditor calibration tutor.
const PURPOSES = ['chat', 'evaluate', 'criteria', 'discuss'];

function providerNameFor(purpose) {
  const perPurpose = purpose ? process.env[`AI_PROVIDER_${String(purpose).toUpperCase()}`] : undefined;
  return String(perPurpose || process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
}

function providerFor(purpose) {
  const name = providerNameFor(purpose);
  const provider = PROVIDERS[name];
  // Fail loudly. Silently falling back to Anthropic on a typo would mean paying cloud rates while
  // believing you were on-prem — and, for `evaluate`, scoring under a model nobody intended.
  if (!provider) {
    throw new Error(`Unknown AI provider "${name}" (from ${purpose ? `AI_PROVIDER_${String(purpose).toUpperCase()} / ` : ''}AI_PROVIDER). Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

/**
 * @param {object}   opts
 * @param {string}   opts.purpose  one of PURPOSES — selects the provider
 * @param {string}   opts.systemPrompt
 * @param {Array}    opts.messages  [{role, content}] — MUST already be de-identified by the caller
 * @param {number}   [opts.maxTokens]
 * @param {number}   [opts.temperature]
 * @returns {Promise<{text, inputTokens, outputTokens, tokenCount, stopReason, provider, model}>}
 */
async function callAI({ purpose, systemPrompt, messages, maxTokens, temperature }) {
  if (purpose && !PURPOSES.includes(purpose)) {
    throw new Error(`Unknown AI purpose "${purpose}". Valid: ${PURPOSES.join(', ')}`);
  }
  const provider = providerFor(purpose);
  return callWith(provider, { systemPrompt, messages, maxTokens, temperature });
}

/**
 * Call a provider BY NAME, bypassing purpose routing.
 *
 * For infrastructure that is inherently about a specific vendor — today only the shadow evaluator,
 * whose entire job is to run the model that ISN'T serving. Routes must keep using callAI(purpose):
 * naming a vendor in a route is what this design exists to prevent.
 */
async function callProvider({ provider: name, systemPrompt, messages, maxTokens, temperature }) {
  const provider = PROVIDERS[String(name || '').trim().toLowerCase()];
  if (!provider) {
    throw new Error(`Unknown AI provider "${name}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return callWith(provider, { systemPrompt, messages, maxTokens, temperature });
}

async function callWith(provider, { systemPrompt, messages, maxTokens, temperature }) {
  const result = await provider.call({ systemPrompt, messages, maxTokens, temperature });
  // `provider` + `model` travel WITH the result, deliberately. A module-level MODEL constant is only
  // correct while exactly one model exists; under a hybrid it silently mislabels which system
  // produced a score (§10.2 provenance) and which rate to bill it at.
  return { ...result, provider: provider.name, model: result.model || provider.model() };
}

// Distinct providers actually reachable under the current config — drives /health/deep, so a
// deployment only probes (and only reports degraded for) the vendors it truly depends on.
function activeProviders() {
  return [...new Set(PURPOSES.map(providerNameFor))];
}

// The provider a purposeless caller would get. NOTE this reads only AI_PROVIDER — it is structurally
// blind to the per-purpose overrides, so it must NOT be used to describe what a deployment runs.
function defaultProvider() {
  return providerFor(null);
}

// The model actually behind each purpose. This is the honest answer to "what is this deployment
// running": with AI_PROVIDER_*=local and AI_PROVIDER unset, defaultProvider() still says anthropic,
// which would have /health/deep report claude-sonnet-4-6 on a box where every call goes to the DGX.
function modelsByPurpose() {
  const out = {};
  for (const purpose of PURPOSES) {
    const name = providerNameFor(purpose);
    const provider = PROVIDERS[name];
    out[purpose] = provider ? { provider: name, model: provider.model() } : { provider: name, model: null };
  }
  return out;
}

// Aggregated readiness across every active provider. Never throws — a probe failure is a `down`
// check, not a 500.
async function readiness() {
  const checks = {};
  for (const name of activeProviders()) {
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

module.exports = { callAI, callProvider, activeProviders, defaultProvider, modelsByPurpose, providerNameFor, readiness, PURPOSES, PROVIDERS };
