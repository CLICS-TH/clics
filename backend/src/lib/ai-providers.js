// Which provider may serve which AI purpose — the backend's ONE list.
//
// Read by the superadmin provider switch (routes/superadmin.js: what the operator is offered, and what
// PATCH /admin/ai-providers accepts) AND by the agreement assembly (services/agreement.js: which
// shadow rows may become the Model Lock's candidate evaluator). Two lists would drift, and the two
// places they would drift between are "what can be switched on" and "what can be frozen as the
// study's measuring instrument".
//
// rimpl enforces the same rule at the AI boundary (rimpl/src/services/ai.js PROVIDER_PURPOSES, with
// `shadow` treated as evaluate-class). The two packages deploy separately and share no code, so this
// is the backend's copy of that rule — keep them in step.
//
// Embeddings are a different market from chat: Anthropic has no embeddings API and Claude cannot
// serve `embed`, so the valid answers differ per purpose. Offering a provider that would throw on
// first use is not a switch, it is a trap.
//
// `local-tutor` is the on-prem TUTOR model (rimpl providers/local-tutor.js), a second on-prem
// endpoint beside the evaluator `local`. Offered for the conversational purposes ONLY: CCME R3 needs
// the evaluator to be a distinct model artifact from the tutor, so the tutor never scores (evaluate),
// never decides whether a session counts (criteria), and is never a candidate evaluator (its shadow
// rows, should any exist, cannot be locked — see evaluateClass below).
const AI_PROVIDER_CHOICES = {
  chat: ['anthropic', 'local', 'local-tutor'],
  evaluate: ['anthropic', 'local'],
  criteria: ['anthropic', 'local'],
  discuss: ['anthropic', 'local', 'local-tutor'],
  embed: ['openai', 'local'],
};

// May this provider produce an evaluation that counts — a served score, or a shadow score that could
// become the locked evaluator? The same answer as "may it serve `evaluate`", by construction.
function evaluateClass(provider) {
  return AI_PROVIDER_CHOICES.evaluate.includes(String(provider ?? '').trim().toLowerCase());
}

// LOCAL-ONLY MODE (ADR 0012, #428): CLICS_LOCAL_ONLY, read the way rimpl reads it
// (rimpl/src/lib/provider-policy.js localOnly): unset/blank or an explicit off spelling is off, ANY other
// value is on. This reads THIS process's variable only. rimpl is the guard (it refuses a commercial provider
// before any call, whatever this list says), and the mode may be set on rimpl alone, so the superadmin
// switch takes the mode as on when EITHER process has it on, or when rimpl's cannot be read
// (routes/superadmin.js localOnlyState). Read per call, so a test or a restart sees the current env.
const LOCAL_ONLY_OFF_VALUES = ['', '0', 'false', 'off', 'no'];
const LOCAL_PROVIDERS = ['local', 'local-tutor'];
function localOnly() {
  return !LOCAL_ONLY_OFF_VALUES.includes(String(process.env.CLICS_LOCAL_ONLY ?? '').trim().toLowerCase());
}
const isLocalProvider = (provider) => LOCAL_PROVIDERS.includes(String(provider ?? '').trim().toLowerCase());

// What the switch offers: every choice with the mode off, the on-prem ones with it on.
function providerChoices(on) {
  if (!on) return AI_PROVIDER_CHOICES;
  return Object.fromEntries(Object.entries(AI_PROVIDER_CHOICES).map(([purpose, list]) => [purpose, list.filter(isLocalProvider)]));
}

module.exports = { AI_PROVIDER_CHOICES, evaluateClass, localOnly, isLocalProvider, providerChoices };
