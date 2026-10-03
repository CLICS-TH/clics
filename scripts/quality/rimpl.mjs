// The single bridge from the tutor-reply audit into rimpl's PRODUCTION code.
//
// Everything a judgement here depends on — the system prompts, the prompt hash, the citation and ❓
// detectors, the rescue post-check, the PII filter that runs before any model sees a turn, and the
// artifact-fence strip — is IMPORTED, never copied. A copy would let the audit pass a model on rules
// production no longer applies.
//
// Package-free: CI's quality job has no npm install. Every module below loads without node_modules
// EXCEPT services/rescue.js, which requires services/ai.js (the provider registry, which pulls the
// Anthropic SDK) only so that its assessQualifying() can make a classifier call. The audit needs
// checkRescueReply — a pure function — and nothing else from that file. So ai.js is replaced in the
// require cache with a stub BEFORE rescue.js loads. The stub throws if anything ever calls it, so a
// future change that made the audit route a call through rescue.js would fail loudly rather than
// spend money or reach a model. If ai.js is already genuinely loaded in this process, it is left alone.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const aiPath = require.resolve('../../rimpl/src/services/ai.js');
if (!require.cache[aiPath]) {
  const Module = require('node:module');
  const stub = new Module(aiPath);
  stub.filename = aiPath;
  stub.loaded = true;
  const refuse = async () => {
    throw new Error('scripts/quality: rimpl services/ai.js is stubbed here — the audit never makes a call through rescue.js');
  };
  stub.exports = { callAI: refuse, embedText: refuse, ragEnabled: () => false };
  require.cache[aiPath] = stub;
}

const prompts = require('../../rimpl/src/lib/prompts.js');
const versions = require('../../rimpl/src/lib/versions.js');
const postFilter = require('../../rimpl/src/services/post-filter.js');
const pii = require('../../rimpl/src/services/pii-filter.js');
const transcript = require('../../rimpl/src/lib/transcript.js');
const rescue = require('../../rimpl/src/services/rescue.js');

export const {
  RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE,
} = prompts;
export const { promptLabel } = versions;
export const {
  hasCitation, extractSocraticQuestion, extractReferences,
  // The production language guard (#109) — ONE definition of "answered in Thai", shared with
  // scripts/probe/thai-probe.mjs. Package-free.
  thaiShare, isLanguageMismatch, isThaiMessage, stripNonProse, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
} = postFilter;
export const { stripPii, stripHistoryPii, deriveHintTokens } = pii;
export const { stripArtifactDelimiters } = transcript;
export const { checkRescueReply, RESCUE_AFTER_EXCHANGES, MAX_RESCUE_QUESTIONS, RESCUE_RETRY_PROMPT } = rescue;

/** Absolute paths of the production files this module mirrors behaviour from (for drift tests). */
export const RIMPL_FILES = {
  chatRoute: require.resolve('../../rimpl/src/routes/chat.js'),
  anthropicProvider: require.resolve('../../rimpl/src/services/providers/anthropic.js'),
};
