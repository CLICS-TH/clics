// What each pinned Anthropic model accepts on a Messages request, PER PURPOSE, in ONE place and with
// no SDK dependency, so the provider (services/providers/anthropic.js) and the offline scripts that
// mirror it (scripts/probe/model-agreement.mjs, repeat-consistency.mjs, scripts/quality/tutor-audit.mjs)
// build the same body. A probe that sends a different body from production measures a different
// instrument.
//
// The pin itself stays in providers/anthropic.js (`const MODEL = '...'`). This file only says what
// that model will and will not take. A model with no entry here is refused at boot, not guessed at.
//
// FROZEN WITH THE FINGERPRINT. The evaluate shape (thinking mode, effort) is recorded in every score's
// §10.2 provenance and enters config_fingerprint (lib/provenance.js). Editing it after the first 5.5
// score splits the corpus in two, exactly like a prompt edit: record it in
// scripts/calibration/prompt-versions.md and never pool the two sides.

// Sonnet 5.5's rules (official migration guide platform.claude.com/docs/en/models/sonnet-5-5/
// migration-guide, and prompting guide .../prompt-engineering/prompting-claude-sonnet-5-5, read
// 2026-10-03):
//  * temperature / top_p / top_k: "a non-default value returns a 400 error. Remove them."
//  * Omitting `thinking` runs ADAPTIVE thinking (4.6 ran none). `{type: 'disabled'}` is a 400.
//    Thinking counts toward max_tokens and bills as output.
//  * `between_tools` = no up-front thinking. "It's accepted at `low`, `medium`, and `high` effort",
//    takes no other field, and every OTHER model rejects it.
//  * Effort goes in `output_config: {effort}`. The API default is `high`; it is sent explicitly here so
//    the shape cannot change under us if that default ever moves.
const S55_EVALUATE = Object.freeze({
  // The PIS-7 evaluator is a reasoning task with JSON output and no tools. The prompting guide, verbatim:
  //   "Use adaptive thinking for reasoning tasks without tools. In a request without tools,
  //    `between_tools` means the model answers without thinking first. For tasks that need a few steps
  //    of working out, use adaptive thinking instead."
  //   "Use adaptive thinking rather than `between_tools`. In a request without tools, the model doesn't
  //    think before it answers under `between_tools`. ... accuracy on these tasks is lower."
  // Effort `high`: the guide's starting point ("Start at `high`, the default on the Claude API, unless
  // your workload is agentic or latency-sensitive"). The evaluation runs in the background drain
  // (backend RIMPL_EVAL_TIMEOUT_MS 480s), so it is neither.
  thinking: Object.freeze({ type: 'adaptive' }),
  effort: 'high',
});
const S55_INTERACTIVE_NO_THINKING = Object.freeze({
  // CHAT and CRITERIA run inside a physician's request under the backend's 100s ceiling
  // (RIMPL_CHAT_TIMEOUT_MS; the rescue classifier is a `criteria` call made INSIDE the chat turn,
  // routes/chat.js, before the reply and a possible citation retry). Measured on 4-6: a single cloud
  // call ran up to 65.7s (docs/GATE0-DGX-RESULTS.md §7.1), and a 948-output-token chat turn took 23.0s
  // (docs/RAG-ROLLOUT-CHECKLIST.md). So one turn can already spend most of the 100s on 4-6 output alone.
  // Adaptive thinking would add thinking tokens ahead of every reply. The guide says "From `medium` up,
  // the model thinks briefly before almost every reply", and at `low` it "skips thinking on most simple
  // requests", which a clinical question usually is not. Nothing here has measured how much that adds on
  // 5.5, and a timeout costs the physician the turn. So these stay on `between_tools` (no up-front
  // thinking, the 4-6 behaviour) until a paid latency run shows adaptive `low` fits.
  // `criteria` must also be the SAME classifier at /end and in the rescue (services/rescue.js), so it
  // cannot take a slower shape at /end alone.
  // Effort `low`: the guide's chat starting point ("For chat and other latency-sensitive work, start at
  // `medium` or `low`") and its classification one. Unmeasured for tutor quality: the paid tutor-audit
  // arm (scripts/quality/tutor-audit.mjs, approval needed) is how to sweep it.
  thinking: Object.freeze({ type: 'between_tools' }),
  effort: 'low',
});
const S55_DISCUSS = Object.freeze({
  // The auditor calibration chat: one call per turn (no retry, no classifier), short prose, reasoning
  // about scores. Adaptive at `low` per the migration guide ("Try adaptive thinking at `low` effort
  // first"). Its max_tokens (routes/audit-discuss.js, 3000) bounds thinking plus reply so one call
  // stays inside the same 100s ceiling.
  thinking: Object.freeze({ type: 'adaptive' }),
  effort: 'low',
});

const SHAPES = Object.freeze({
  // The pre-2026-10 incumbent. Kept so a rollback is the one-line MODEL change and nothing else.
  // Purpose-independent: omitting `thinking` runs WITHOUT thinking; temperature is accepted; no effort.
  'claude-sonnet-4-6': Object.freeze({ sampling: true, purposes: null }),

  'claude-sonnet-5-5': Object.freeze({
    sampling: false,
    purposes: Object.freeze({
      evaluate: S55_EVALUATE,
      // The shadow evaluator (services/shadow.js) scores the same transcript as the served evaluation,
      // so it gets the evaluator's shape. A different shape would compare two instruments.
      shadow: S55_EVALUATE,
      chat: S55_INTERACTIVE_NO_THINKING,
      criteria: S55_INTERACTIVE_NO_THINKING,
      discuss: S55_DISCUSS,
    }),
  }),
});

/**
 * The model-specific part of a Messages request body, plus a record of what it actually sends.
 *
 * @param {string} model  the pinned model id
 * @param {{temperature?: number, purpose?: string}} [opts]  what the caller ASKED for, and why
 * @returns {{fields: object, sent: {temperature: number|null, thinking: string|null, effort: string|null}, dropped: string[]}}
 *   `fields` is spread into the request body. `sent` is the §10.2 decoding record: what went over the
 *   wire, never what was requested. `dropped` names any requested parameter the model refuses.
 * @throws when the model has no declared shape, or (for a per-purpose model) the purpose has none, so an
 *   unreviewed combination can never go out.
 */
function requestShape(model, { temperature, purpose } = {}) {
  const shape = SHAPES[model];
  if (!shape) {
    throw new Error(`No Anthropic request shape is declared for "${model}". Add it to rimpl/src/lib/anthropic-request.js (after checking the model's migration guide) before pinning it.`);
  }
  let p = null;
  if (shape.purposes) {
    p = shape.purposes[purpose];
    if (!p) throw new Error(`No Anthropic request shape is declared for "${model}" with purpose "${purpose}". Declared: ${Object.keys(shape.purposes).join(', ')}.`);
  }
  const fields = {};
  const dropped = [];
  if (p?.thinking) fields.thinking = { ...p.thinking };
  if (p?.effort) fields.output_config = { effort: p.effort };
  if (temperature != null) {
    if (shape.sampling) fields.temperature = temperature;
    else dropped.push('temperature');
  }
  return {
    fields,
    sent: {
      temperature: fields.temperature ?? null,
      thinking: fields.thinking?.type ?? null,
      effort: fields.output_config?.effort ?? null,
    },
    dropped,
  };
}

/** The purposes a model declares a shape for (null when it is purpose-independent). */
function declaredPurposes(model) {
  const s = SHAPES[model];
  return s?.purposes ? Object.keys(s.purposes) : null;
}

module.exports = { requestShape, declaredPurposes, SHAPES };
