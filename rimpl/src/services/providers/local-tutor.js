// The on-prem TUTOR model — a second instance of the OpenAI-compatible transport in
// providers/local-factory.js, for CCME's tutor model (purpose chat / discuss), served from a different
// endpoint with a different key than the evaluator (providers/local.js, name 'local').
//
// WHY A SEPARATE PROVIDER (CCME requirement R3): the PIS-7 evaluator must be a distinct model artifact
// from the tutor whose dialogue it scores. Routing stays exactly as it was — per purpose,
// app_settings.ai_provider_<purpose> → AI_PROVIDER_<PURPOSE> → AI_PROVIDER (services/ai.js) — so this
// instance is DORMANT until one of those names it. services/ai.js refuses to route evaluate or
// criteria to it (PROVIDER_PURPOSES), and backend's superadmin switch offers it for chat and discuss
// only.
//
// Own everything that is per endpoint: base URL, model, key, deadline, context floor, size backstop,
// queue (LOCAL_TUTOR_*), prompt-size calibration and /health/deep check key (local_tutor_ai). The
// HTTP proxy is the one thing it inherits: LOCAL_TUTOR_AI_HTTP_PROXY when that is SET (the empty
// string = go direct), else LOCAL_AI_HTTP_PROXY — both boxes sit behind the same tailnet, and the
// Tailscale proxy in the rimpl container is one per deployment, not one per box.
//
// No embeddings: it is not in services/ai.js EMBED_PROVIDERS, and exports no embed().
//
// PII: a transport, like every provider. De-identification happens upstream in the routes.
const { createLocalProvider } = require('./local-factory');

module.exports = createLocalProvider({
  name: 'local-tutor',
  // LOCAL_TUTOR_AI_BASE_URL / _MODEL / _API_KEY / _TIMEOUT_MS / _MIN_CONTEXT / _NUM_CTX /
  // _MAX_PROMPT_TOKENS / _HTTP_PROXY / _THINKING_STYLE
  envPrefix: 'LOCAL_TUTOR_AI_',
  // LOCAL_TUTOR_MAX_CONCURRENCY / _MAX_RETRIES / _RETRY_BASE_MS / _INTERACTIVE_RESERVE /
  // _MAX_QUEUE_INTERACTIVE / _MAX_QUEUE_BACKGROUND / _QUEUE_RETRY_AFTER_S / _LOG_PROMPT_RATIO
  queuePrefix: 'LOCAL_TUTOR_',
  checkKey: 'local_tutor_ai',
  minContextKey: 'local_tutor_ai_min_context',
  proxyEnv: ['LOCAL_TUTOR_AI_HTTP_PROXY', 'LOCAL_AI_HTTP_PROXY'],
  embeddings: false,
  label: 'local tutor AI',
});
