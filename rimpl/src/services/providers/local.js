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
//
// THIS INSTANCE IS THE EVALUATOR (DeepSeek, purpose evaluate/criteria). Its name, 'local', is keyed on
// by the evaluator path — lib/prompts.js pis7PromptFor (the local addendum), lib/versions.js
// promptVersionFor (+local- suffix), routes/evaluate.js consistencyModeFor, services/shadow.js — and
// stamped on every historical score and shadow row, so it must not move. The tutor model is a SECOND
// instance of the same transport, providers/local-tutor.js (CCME R3: the evaluator must be a distinct
// model artifact from the tutor). The implementation, and every comment on how it behaves, lives in
// providers/local-factory.js; this file only fixes this instance's names. Its env names are exactly
// the ones this module has always read.
const { createLocalProvider } = require('./local-factory');
const { LOCAL_INSTANCES } = require('../../lib/provider-policy');

module.exports = createLocalProvider({
  name: 'local',
  // LOCAL_AI_BASE_URL / _MODEL / _API_KEY / _TIMEOUT_MS / _MIN_CONTEXT / _NUM_CTX / _MAX_PROMPT_TOKENS /
  // _EMBED_MODEL / _EMBED_TIMEOUT_MS / _HTTP_PROXY / _THINKING_STYLE
  envPrefix: LOCAL_INSTANCES.local.envPrefix,   // 'LOCAL_AI_'
  // LOCAL_MAX_CONCURRENCY / _MAX_RETRIES / _RETRY_BASE_MS / _INTERACTIVE_RESERVE / _MAX_QUEUE_INTERACTIVE /
  // _MAX_QUEUE_BACKGROUND / _QUEUE_RETRY_AFTER_S / _LOG_PROMPT_RATIO
  queuePrefix: LOCAL_INSTANCES.local.queuePrefix,   // 'LOCAL_'
  checkKey: 'local_ai',
  minContextKey: 'local_ai_min_context',
  // The embed lane (services/ai.js EMBED_PROVIDERS) runs on this box when ai_provider_embed = local.
  embeddings: true,
});
