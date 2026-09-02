// lib/prompts.js pis7PromptFor + lib/versions.js promptVersionFor — the local addendum and how it
// shows in provenance. The addendum is EMPTY until the E2 tuning round, so the non-empty branch is
// exercised here through the helpers' injectable parameter: the guarantee that a score produced under
// a tuned local prompt can never be mistaken for one produced under the base must hold before E2
// flips it on, not be discovered then.
const crypto = require('crypto');
const { PIS7_EVALUATOR_PROMPT, PIS7_LOCAL_ADDENDUM, pis7PromptFor } = require('../src/lib/prompts');
const { PROMPT_VERSION, promptVersionFor } = require('../src/lib/versions');

const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('today: the addendum is empty', () => {
  test('PIS7_LOCAL_ADDENDUM is the empty string (E2 has not run)', () => {
    expect(PIS7_LOCAL_ADDENDUM).toBe('');
  });

  test.each(['local', 'anthropic', undefined])('pis7PromptFor(%s) is the base prompt, byte for byte', (provider) => {
    expect(pis7PromptFor(provider)).toBe(PIS7_EVALUATOR_PROMPT);
  });

  test.each(['local', 'anthropic', undefined])('promptVersionFor(%s) is PROMPT_VERSION', (provider) => {
    expect(promptVersionFor(provider)).toBe(PROMPT_VERSION);
  });

  test('PROMPT_VERSION is derived from the base prompt text (the rubric-sync pin)', () => {
    expect(PROMPT_VERSION).toBe(`pis7-prompt-${crypto.createHash('sha256').update(PIS7_EVALUATOR_PROMPT).digest('hex').slice(0, 8)}`);
  });
});

describe('with a non-empty addendum (what E2 will turn on)', () => {
  const ADDENDUM = 'Score conservatively when the physician restates the AI.';

  test('the local prompt is base + blank line + addendum; the rubric text itself does not move', () => {
    const p = pis7PromptFor('local', ADDENDUM);
    expect(p).toBe(`${PIS7_EVALUATOR_PROMPT}\n\n${ADDENDUM}`);
    expect(p.startsWith(PIS7_EVALUATOR_PROMPT)).toBe(true);
  });

  test('anthropic still receives the base prompt', () => {
    expect(pis7PromptFor('anthropic', ADDENDUM)).toBe(PIS7_EVALUATOR_PROMPT);
  });

  test('the local prompt version is PROMPT_VERSION + "+local-" + sha256(addendum)[0:12]; the base stays the base', () => {
    expect(promptVersionFor('local', ADDENDUM)).toBe(`${PROMPT_VERSION}+local-${sha12(ADDENDUM)}`);
    expect(promptVersionFor('anthropic', ADDENDUM)).toBe(PROMPT_VERSION);
    expect(promptVersionFor('local', ADDENDUM)).not.toBe(PROMPT_VERSION);
  });

  test('a different addendum is a different version', () => {
    expect(promptVersionFor('local', `${ADDENDUM} Revised.`)).not.toBe(promptVersionFor('local', ADDENDUM));
  });
});
