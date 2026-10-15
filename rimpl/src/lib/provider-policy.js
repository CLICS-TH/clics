'use strict';

// Which provider may serve which purpose, and the one model id that is pinned in code — the ROUTING
// POLICY, as data. services/ai.js routes with it; the model manifest (lib/manifest.js) records it.
//
// PACKAGE-FREE ON PURPOSE, like lib/thinking-control.js: no require() at all. services/ai.js loads every
// provider, and the providers load the Anthropic SDK and provider-settings.js (which validates env at
// load), so nothing that must run on CI's bare checkout (scripts/manifest/build.mjs) could read these
// from there. Moving them here changed no value: ai.js and providers/anthropic.js import them.

// Every chat-completion provider services/ai.js registers (its PROVIDERS keys; ai.js refuses to load if
// the two lists disagree). Each name is what results, provenance rows and bills are stamped with.
const PROVIDER_NAMES = Object.freeze(['anthropic', 'local', 'local-tutor']);

// 'criteria' = the C1–C6 classifier, 'discuss' = the auditor calibration tutor.
const PURPOSES = Object.freeze(['chat', 'evaluate', 'criteria', 'discuss']);

// The embedding registry is separate (services/ai.js EMBED_PROVIDERS): Anthropic has no embeddings API.
const EMBED_PROVIDER_NAMES = Object.freeze(['openai', 'local']);

// Resolution, per call (services/ai.js providerNameFor / embedProviderName):
//   app_settings.ai_provider_<purpose>  ->  AI_PROVIDER_<PURPOSE>  ->  AI_PROVIDER (EMBED_PROVIDER for embed)  ->  these
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_EMBED_PROVIDER = 'openai';

// The purposes a provider may serve, for a provider that may NOT serve all of them; a provider absent
// from this map serves every purpose.
//
// `local-tutor` is the TUTOR model, and CCME R3 requires the evaluator to be a distinct model
// artifact from the tutor. evaluate scores the very dialogue the tutor produced, and criteria decides
// whether that dialogue counts — routing either to the tutor would judge a model's conversation with
// the same model, under a prompt nobody calibrated it on. Backend's superadmin switch offers
// local-tutor for chat and discuss only; this is the same rule at the boundary, so an env var
// (AI_PROVIDER=local-tutor, the easy way to mean "all on-prem" and get it wrong) or a hand-written
// app_settings row cannot do what the switch refuses. It fails LOUDLY — the call throws, and
// readiness() reports the purpose down — exactly like an unknown provider name.
const PROVIDER_PURPOSES = Object.freeze({ 'local-tutor': Object.freeze(['chat', 'discuss']) });

// Purposes that are not in PURPOSES but must obey the same rule as one that is. `shadow` is a second,
// never-served PIS-7 score of the same transcript (services/shadow.js): it IS an evaluation, and its
// rows are the corpus a candidate evaluator is judged and locked on. Shadow-scoring with the tutor
// would produce agreement data that looks like a candidate evaluator and is not one — so whatever
// may not `evaluate` may not `shadow` either. One list (PROVIDER_PURPOSES), read through this map.
const PURPOSE_CLASS = Object.freeze({ shadow: 'evaluate' });

function servesPurpose(name, purpose) {
  const allowed = PROVIDER_PURPOSES[name];
  return !purpose || !allowed || allowed.includes(PURPOSE_CLASS[purpose] ?? purpose);
}

// Only `chat` may fail over (services/ai.js callAI), and only on DOWN-class errors. evaluate / criteria /
// discuss / shadow never do: PIS-7 scoring relocating to another model mid-cohort is the one outcome the
// routing design exists to prevent. CHAT_FAILOVER_PROVIDER ships unset (an ethics decision).
const FAILOVER_PURPOSES = Object.freeze(['chat']);

// The on-prem instances of the OpenAI-compatible transport (services/providers/local-factory.js) and
// the env prefixes each reads, so the manifest can name every knob without loading the transport.
// `local` is the EVALUATOR and must keep that name (lib/prompts.js pis7PromptFor, lib/versions.js
// promptVersionFor and every historical score key on it); `local-tutor` is the tutor (CCME R3).
const LOCAL_INSTANCES = Object.freeze({
  local: Object.freeze({ envPrefix: 'LOCAL_AI_', queuePrefix: 'LOCAL_' }),
  'local-tutor': Object.freeze({ envPrefix: 'LOCAL_TUTOR_AI_', queuePrefix: 'LOCAL_TUTOR_' }),
});

// <prefix>NUM_CTX when unset: 0 = off, no `options.num_ctx` is sent (providers/local-factory.js call()).
const LOCAL_NUM_CTX_DEFAULT = 0;

// The inference engines a server's `system_fingerprint` may name as its leading token
// (providers/local-factory.js engineOf). Anything else is recorded as engine null, never a guess. Here,
// package-free, so the model manifest can treat a reported engine as a fixed vocabulary.
const KNOWN_ENGINES = Object.freeze(['vllm', 'ollama', 'llamacpp', 'tgi', 'sglang', 'mlx', 'trtllm', 'lmdeploy']);

// PINNED, not an alias. From the 4.6 generation on, Anthropic's canonical model ids carry no date:
// GET /v1/models/claude-sonnet-4-6 resolves to itself (created 2026-02-17), the same way the older
// dated ids (claude-sonnet-4-5-20250929) do. Verified 2026-10-02. Never swap this for a moving alias
// (a "-latest" name): CREC082 §10.2 requires the model behind every score to be fixed and recorded.
// services/providers/anthropic.js sends exactly this (its MODEL).
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

module.exports = {
  PROVIDER_NAMES, PURPOSES, EMBED_PROVIDER_NAMES, DEFAULT_PROVIDER, DEFAULT_EMBED_PROVIDER,
  PROVIDER_PURPOSES, PURPOSE_CLASS, servesPurpose, FAILOVER_PURPOSES,
  LOCAL_INSTANCES, LOCAL_NUM_CTX_DEFAULT, KNOWN_ENGINES, ANTHROPIC_MODEL,
};
