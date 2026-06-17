// Evaluator provenance (CLICS_Proposal §10.2): the Evaluator AI must produce one score set per
// transcript under a LOCKED model + prompt + rubric, and the version must be recorded per evaluation
// so a reliability/stability check can detect drift. PROMPT_VERSION/RUBRIC_VERSION are derived from a
// hash of the actual prompt/weights TEXT, so any silent edit bumps the recorded version automatically.
const crypto = require('crypto');
const { MODEL } = require('../services/claude');
const { PIS7_EVALUATOR_PROMPT } = require('./prompts');

// Single source of truth for the PIS-7 weights (mirrors backend/src/services/cle-gate.js WEIGHTS).
const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

const MODEL_VERSION = `CCME_LLM_v8.0+${MODEL || 'claude'}`;
const PROMPT_VERSION = `pis7-prompt-${sha8(PIS7_EVALUATOR_PROMPT)}`;
const RUBRIC_VERSION = `pis7-weights-${sha8(JSON.stringify(WEIGHTS))}`;

module.exports = { WEIGHTS, MODEL_VERSION, PROMPT_VERSION, RUBRIC_VERSION };
