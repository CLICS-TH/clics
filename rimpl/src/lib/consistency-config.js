'use strict';

// The self-consistency RULE's configuration (services/consistency.js; docs/LOCAL-MODEL-ROADMAP.md D18 /
// D21): its vocabulary, its default thresholds, and the env knobs the served and shadow evaluators read.
// The rule itself — the calls and the reconciliation — stays in services/consistency.js, which needs zod
// through lib/pis7.js; these are the numbers and names, kept PACKAGE-FREE (no require() at all) so the
// model manifest (lib/manifest.js, scripts/manifest/build.mjs on CI's bare checkout) records the same
// values the evaluator runs with. Moving them here changed no value and no behaviour.
//
// Resolvers take the env as an argument (default process.env), so resolve({}) is the code default.

// The rule names, mode names and option keys are a CONTRACT with scripts/probe/repeat-consistency.mjs
// (--consistency off|adaptive|median3 --agree-sum N), which runs services/consistency.js against saved
// replies; MODES is exported so the flag can be validated against it.
const METHOD = 'self-consistency';
const MODES = Object.freeze(['off', 'adaptive', 'median3']);
const RULES = Object.freeze({ single: 'single', pair: 'first-of-agreeing-pair', median: 'median-of-3' });

// When does the pair c1/c2 AGREE? (services/consistency.js normaliseAgree)
//   maxDomainDelta  no domain may differ by more than this (the historical rule);
//   maxSumDelta     Σ|Δ| over d1..d7 may not exceed this; 0 = off, i.e. the per-domain check alone.
// The defaults reproduce the historical behaviour byte for byte.
const DEFAULT_AGREE = Object.freeze({ maxDomainDelta: 1, maxSumDelta: 0 });

// The env knobs, each with its code default. EVAL_CONSISTENCY applies to the LOCAL arm only: the
// incumbent (anthropic) path is a single call whatever the env says (routes/evaluate.js), so its
// response and its config_fingerprint stay byte-identical. The shadow never re-asks (services/shadow.js:
// shadow_evaluations has no column to record a re-ask), so it has no json_retries knob.
const ENV = Object.freeze({
  mode: Object.freeze({ env: 'EVAL_CONSISTENCY', default: 'off', appliesTo: 'local' }),
  maxSumDelta: Object.freeze({ env: 'EVAL_CONSISTENCY_MAX_SUM_DELTA', default: DEFAULT_AGREE.maxSumDelta }),
  jsonRetries: Object.freeze({ env: 'EVAL_JSON_RETRIES', default: 2 }),
  shadowMode: Object.freeze({ env: 'SHADOW_EVAL_CONSISTENCY', default: 'off' }),
});

const modeFrom = (raw) => {
  const mode = String(raw || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : null;
};

// The served evaluator's mode for `provider`. An unknown value is off.
function consistencyModeFor(provider, env = process.env) {
  const mode = modeFrom(env?.[ENV.mode.env]);
  return provider === ENV.mode.appliesTo && mode ? mode : ENV.mode.default;
}

// Σ|Δ| ceiling for the adaptive pair to count as agreeing (0 = the per-domain check alone). A uniform
// ±1 level shift across 5–6 domains passes the per-domain check with Σ|Δ| = 5–6, and the D18
// repeatability bar is Σ|Δ| median ≤ 2. A property of the RULE, so the shadow reads the same knob.
function maxSumDelta(env = process.env) {
  const n = parseInt(env?.[ENV.maxSumDelta.env], 10);
  return Number.isFinite(n) && n >= 0 ? n : ENV.maxSumDelta.default;
}

// Re-asks allowed across one adaptive / median3 evaluation when the model returns unparseable /
// out-of-range JSON. Not applied to the incumbent path (mode off): a re-ask there would be a new
// cloud-spend path on the instrument the pilot is locked to.
function jsonRetries(env = process.env) {
  const n = parseInt(env?.[ENV.jsonRetries.env], 10);
  return Number.isFinite(n) && n >= 0 ? n : ENV.jsonRetries.default;
}

// The shadow arm's mode: off (default) | adaptive | median3. An unknown value is off.
function shadowConsistencyMode(env = process.env) {
  return modeFrom(env?.[ENV.shadowMode.env]) ?? ENV.shadowMode.default;
}

module.exports = {
  METHOD, MODES, RULES, DEFAULT_AGREE, ENV,
  consistencyModeFor, maxSumDelta, jsonRetries, shadowConsistencyMode,
};
