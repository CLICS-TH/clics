// lib/prompts.js pis7PromptFor + lib/versions.js promptVersionFor — the local addendum and how it
// shows in provenance. The addendum is EMPTY until the E2 tuning round, so the non-empty branch is
// exercised here through the helpers' injectable parameter: the guarantee that a score produced under
// a tuned local prompt can never be mistaken for one produced under the base must hold before E2
// flips it on, not be discovered then.
const crypto = require('crypto');
const { PIS7_EVALUATOR_PROMPT, PIS7_LOCAL_ADDENDUM, pis7PromptFor } = require('../src/lib/prompts');
const { PROMPT_VERSION, promptVersionFor } = require('../src/lib/versions');

const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('the local addendum is ON (E2, 2026-09-02) and reaches ONLY the local arm', () => {
  test('PIS7_LOCAL_ADDENDUM is non-empty and adds scoring PROCESS only — no rubric level text', () => {
    expect(PIS7_LOCAL_ADDENDUM.length).toBeGreaterThan(0);
    // The levels, weights and domain definitions live in the base prompt, are mirrored in
    // audit-dashboard/lib/pis7-rubric.ts and are pinned by backend/tests/rubric-sync.test.js. An
    // addendum that restated any of them would put an AI and a human on two different rubrics.
    expect(PIS7_LOCAL_ADDENDUM).not.toMatch(/DOMAINS AND WEIGHTS|SCALE \(|\d+%\)/);
  });

  test.each(['anthropic', undefined])('pis7PromptFor(%s) is the base prompt, byte for byte', (provider) => {
    expect(pis7PromptFor(provider)).toBe(PIS7_EVALUATOR_PROMPT);
  });

  test('pis7PromptFor(local) is the base prompt plus the addendum, and starts with the base', () => {
    expect(pis7PromptFor('local')).toBe(`${PIS7_EVALUATOR_PROMPT}\n\n${PIS7_LOCAL_ADDENDUM}`);
    expect(pis7PromptFor('local').startsWith(PIS7_EVALUATOR_PROMPT)).toBe(true);
  });

  // ---- the JSON contract, twice regressed, now pinned -------------------------------------------
  // 330dc9a appended the addendum and displaced "Return ONLY valid JSON" from the end of the prompt;
  // the model stopped returning parseable output and one fixture burned 33 minutes in re-asks.
  // 04d2db7 fixed it by restating the contract at the close of the addendum. Nothing tested that,
  // so the next edit could undo it silently — as an edit in this same session briefly did.
  test('the assembled local prompt still ENDS with the output contract', () => {
    const tail = pis7PromptFor('local').trimEnd().split('\n\n').pop();
    expect(tail).toMatch(/reply with ONLY the JSON object/);
    expect(tail).toMatch(/nothing before it and nothing after it\.$/);
  });

  // The addendum's symmetric-evidence rule made in-rationale quoting the norm (measured on the
  // tuning split: the "you must quote" rule fires on ~55% of domain scores, up from 3.2% under the
  // base prompt alone), and a rationale is a JSON string. A straight double quote inside one closes
  // the string early -> lib/parse.js throws -> Pis7ScoreError('invalid_json') -> a re-ask. The
  // addendum therefore must not DEMONSTRATE the character its own output rule forbids: its three
  // worked examples are single-quoted. This is typography, not rubric — see the comment in
  // src/lib/prompts.js.
  test('the addendum contains no straight double quote, and states the single-quote rule', () => {
    expect(PIS7_LOCAL_ADDENDUM).not.toContain('"');
    expect(PIS7_LOCAL_ADDENDUM).toMatch(/SINGLE quotes/);
  });

  test('the addendum still requires quoting in BOTH directions — the ICC-bearing rule is intact', () => {
    // The quoting rule buys parse reliability with punctuation only. If a future edit ever buys it
    // by relaxing the evidence requirement instead, that trades away the 0.578 -> 0.735 ICC lift.
    expect(PIS7_LOCAL_ADDENDUM).toMatch(/evidence rule is SYMMETRIC/);
    expect(PIS7_LOCAL_ADDENDUM).toMatch(/Score each domain on ITS OWN evidence/);
  });

  test.each(['anthropic', undefined])('promptVersionFor(%s) is PROMPT_VERSION', (provider) => {
    expect(promptVersionFor(provider)).toBe(PROMPT_VERSION);
  });

  test('promptVersionFor(local) suffixes the version with the addendum sha — a scored row says which text produced it', () => {
    const sha = crypto.createHash('sha256').update(PIS7_LOCAL_ADDENDUM).digest('hex').slice(0, 12);
    expect(promptVersionFor('local')).toBe(`${PROMPT_VERSION}+local-${sha}`);
    expect(promptVersionFor('local')).not.toBe(PROMPT_VERSION);
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
