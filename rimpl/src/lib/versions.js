// Evaluator provenance (CLICS_Proposal §10.2): the Evaluator AI must produce one score set per
// transcript under a LOCKED model + prompt + rubric, and the version must be recorded per evaluation
// so a reliability/stability check can detect drift. PROMPT_VERSION/RUBRIC_VERSION are derived from a
// hash of the actual prompt/weights TEXT, so any silent edit bumps the recorded version automatically.
const crypto = require('crypto');
const { PIS7_EVALUATOR_PROMPT, PIS7_LOCAL_ADDENDUM } = require('./prompts');

// Single source of truth for the PIS-7 weights (mirrors backend/src/services/ple-gate.js WEIGHTS).
const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

// A FUNCTION, not a constant: the model is now a per-call property (services/ai.js resolves the
// provider per request), so provenance must be stamped from the model that ACTUALLY produced the
// score. A module-level constant was correct only while exactly one model could ever run; under a
// hybrid or a shadow evaluation it would silently mislabel every row.
function modelVersion(model) {
  return `CCME_LLM_v8.0+${model || 'claude'}`;
}

const PROMPT_VERSION = `pis7-prompt-${sha8(PIS7_EVALUATOR_PROMPT)}`;
const RUBRIC_VERSION = `pis7-weights-${sha8(JSON.stringify(WEIGHTS))}`;

// The version of the prompt a given provider ACTUALLY receives (lib/prompts.js pis7PromptFor). The
// base stays PROMPT_VERSION for every provider; a non-empty local addendum shows as a suffix, so a
// score produced under a tuned local prompt can never be mistaken for one produced under the base —
// and the human raters, who calibrate against the base rubric, can see which they are being compared to.
// `addendum` defaults to the module's (lib/prompts.js); the parameter mirrors pis7PromptFor's so the
// suffix can be tested before E2 turns it on.
function promptVersionFor(provider, addendum = PIS7_LOCAL_ADDENDUM) {
  if (provider !== 'local' || !addendum) return PROMPT_VERSION;
  return `${PROMPT_VERSION}+local-${crypto.createHash('sha256').update(addendum).digest('hex').slice(0, 12)}`;
}

module.exports = { WEIGHTS, modelVersion, PROMPT_VERSION, RUBRIC_VERSION, promptVersionFor };
