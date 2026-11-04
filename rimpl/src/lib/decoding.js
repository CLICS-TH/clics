'use strict';

// The decoding parameters each AI purpose sends (temperature, max_tokens), in ONE place per purpose,
// as CODE DEFAULTS plus the env var that may override each one. The routes read the resolved value from
// here; the model manifest (lib/manifest.js) records the defaults and the env names. The chat ceilings
// live in lib/turn-limits.js, because the transcript cap is derived from them.
//
// PACKAGE-FREE ON PURPOSE: no require() at all. The routes that send these pull in zod, express and the
// providers; scripts/manifest/build.mjs runs on CI's bare checkout and has to read the same numbers.
//
// A resolver takes the env as an argument (default process.env), so the manifest can ask for the code
// default — resolve({}) — without depending on whatever env the build machine has.

// Parse an integer env value defensively: Math.max(x, parseInt('auto', 10)) is NaN, not x, and a NaN
// maxTokens serialises to `"max_tokens": null` on the wire (Anthropic 400s; an OpenAI-compatible server
// generates to its context limit). A bad or below-floor value falls back to the documented default.
function intFrom(env, name, dflt, min = 0) {
  const n = parseInt(env?.[name], 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

// THE PIS-7 EVALUATOR (routes/evaluate.js). §10.2 requires these frozen and recorded, and the only way
// the recorded value cannot drift from the value sent is for both to read this. Not env-tunable.
// temperature 0: the scoring instrument must be reproducible, and a sampled score is not.
// max_tokens 4096: a 130k-token transcript (PLE-052, 2026-08-17) truncated the JSON mid-rationale at
// both 2000 and 3000 — see the call site. A ceiling, not a spend.
const EVAL_DECODING = Object.freeze({ temperature: 0, maxTokens: 4096 });

// THE SHADOW EVALUATOR (services/shadow.js): the candidate is scored under the SAME decoding as the
// instrument it may replace. Until 2026-10-15 the shadow sent no temperature at all — the candidate
// server's own default — while the served evaluator sent 0, so the corpus the Model Lock picks its
// candidate from was measured under different decoding from the instrument being frozen. Temperature is
// EVAL_DECODING's and not tunable; the ceiling defaults to EVAL_DECODING's and keeps its env override
// (floor 1000), because a shadow truncated at a smaller ceiling would look like a model failure.
const SHADOW_DECODING = Object.freeze({
  temperature: EVAL_DECODING.temperature,
  maxTokens: Object.freeze({ default: EVAL_DECODING.maxTokens, min: 1000, env: 'SHADOW_EVAL_MAX_TOKENS' }),
});
const shadowMaxTokens = (env = process.env) =>
  intFrom(env, SHADOW_DECODING.maxTokens.env, SHADOW_DECODING.maxTokens.default, SHADOW_DECODING.maxTokens.min);

// THE PLE DIALOGUE (routes/chat.js): no temperature is sent, on any call of a turn (the provider's own
// default). The ceilings are lib/turn-limits.js (CHAT_MAX_TOKENS / CHAT_DEEP_MAX_TOKENS), because the
// transcript cap is derived from them. A null temperature is passed through and never reaches the wire
// (both providers send `temperature` only when it is non-null), so the request is what it always was.
const CHAT_DECODING = Object.freeze({ temperature: null });

// THE BOOTH TYPED SORT (services/booth.js): the kiosk call that sorts a typed answer into a tier. temperature 0,
// so the same words sort alike from one play to the next. Not env-tunable: fairness must not depend on a deploy's env.
const BOOTH_TYPED_DECODING = Object.freeze({ temperature: 0 });

// THE QUALIFYING CLASSIFIER (routes/evaluate-criteria.js on /end, services/rescue.js per chat turn):
// one small JSON object. No temperature is sent (the provider default). Not env-tunable.
const CRITERIA_DECODING = Object.freeze({ temperature: null, maxTokens: 200 });

// THE AUDITOR CALIBRATION TUTOR (routes/audit-discuss.js): short prose, no tables or artifacts — the
// auditor's separate $0.50 pool bounds total spend, but the transcript context per turn is large.
// No temperature is sent. RIMPL_DISCUSS_MAX_TOKENS overrides the ceiling, floored at 800.
const DISCUSS_DECODING = Object.freeze({
  temperature: null,
  maxTokens: Object.freeze({ default: 1200, min: 800, env: 'RIMPL_DISCUSS_MAX_TOKENS' }),
});
// Same result as the historical Math.max(800, parseInt(env || '1200')) for every valid value; a value
// that does not parse now falls back to the default instead of becoming NaN (a null max_tokens).
function discussMaxTokens(env = process.env) {
  const { default: dflt, min, env: name } = DISCUSS_DECODING.maxTokens;
  const n = parseInt(env?.[name] || String(dflt), 10);
  return Number.isFinite(n) ? Math.max(min, n) : dflt;
}

module.exports = {
  EVAL_DECODING, SHADOW_DECODING, CHAT_DECODING, BOOTH_TYPED_DECODING, CRITERIA_DECODING, DISCUSS_DECODING,
  shadowMaxTokens, discussMaxTokens, intFrom,
};
