// What each pinned Anthropic model accepts on a Messages request, in ONE place and with no SDK
// dependency, so the provider (services/providers/anthropic.js) and the offline scripts that mirror
// it (scripts/probe/model-agreement.mjs, repeat-consistency.mjs, scripts/quality/tutor-audit.mjs)
// build the same body. A probe that sends a different body from production measures a different
// instrument.
//
// The pin itself stays in providers/anthropic.js (`const MODEL = '...'`); this file only says what
// that model will and will not take. A model with no entry here is refused at boot, not guessed at.

const SHAPES = Object.freeze({
  // The pre-2026-10 incumbent. Kept so a rollback is the one-line MODEL change and nothing else.
  // Omitting `thinking` runs WITHOUT thinking; temperature is accepted.
  'claude-sonnet-4-6': Object.freeze({ thinking: null, sampling: true }),

  // Verified against the official Sonnet 5.5 migration guide (platform.claude.com/docs/en/models/
  // sonnet-5-5/migration-guide), 2026-10-03:
  //  * temperature / top_p / top_k: "a non-default value returns a 400 error. Remove them." So the
  //    evaluator's temperature 0 is NOT sent, and provenance records null, which is what was sent.
  //  * Omitting `thinking` now runs ADAPTIVE thinking (4.6 ran none). Thinking tokens count against
  //    max_tokens and bill as output, so the evaluator's 4096 and chat's ceiling would be shared with
  //    reasoning nobody sees. `{type: 'disabled'}` is a 400 on this model.
  //  * `between_tools` is the lowest setting: no up-front thinking, and with no tools in the request
  //    (rimpl sends none) the reply is text only. That is the closest match to how 4.6 ran. It is
  //    accepted at effort low/medium/high (the API default is high; rimpl sends no effort) and every
  //    OTHER model rejects it, which is why it is keyed to the model here rather than sent blindly.
  'claude-sonnet-5-5': Object.freeze({ thinking: Object.freeze({ type: 'between_tools' }), sampling: false }),
});

/**
 * The model-specific part of a Messages request body, plus a record of what it actually sends.
 *
 * @param {string} model  the pinned model id
 * @param {{temperature?: number}} [opts]  what the caller ASKED for
 * @returns {{fields: object, sent: {temperature: number|null, thinking: string|null}, dropped: string[]}}
 *   `fields` is spread into the request body. `sent` is the §10.2 decoding record: what went over
 *   the wire, never what was requested. `dropped` names any requested parameter the model refuses.
 * @throws when the model has no declared shape, so an unreviewed model id can never go out.
 */
function requestShape(model, { temperature } = {}) {
  const shape = SHAPES[model];
  if (!shape) {
    throw new Error(`No Anthropic request shape is declared for "${model}". Add it to rimpl/src/lib/anthropic-request.js (after checking the model's migration guide) before pinning it.`);
  }
  const fields = {};
  const dropped = [];
  if (shape.thinking) fields.thinking = { ...shape.thinking };
  if (temperature != null) {
    if (shape.sampling) fields.temperature = temperature;
    else dropped.push('temperature');
  }
  return {
    fields,
    sent: { temperature: fields.temperature ?? null, thinking: fields.thinking?.type ?? null },
    dropped,
  };
}

module.exports = { requestShape, SHAPES };
