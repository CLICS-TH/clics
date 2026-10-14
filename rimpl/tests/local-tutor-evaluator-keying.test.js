// The evaluator path keys on the provider NAME 'local' — the local PIS-7 addendum (lib/prompts.js
// pis7PromptFor), the +local- prompt-version suffix (lib/versions.js promptVersionFor), the
// self-consistency rule (routes/evaluate.js consistencyModeFor) and the shadow row's prompt_version
// (services/shadow.js blankRow). Adding a second local transport named 'local-tutor' must not inherit
// any of it: the addendum was tuned and measured for the DeepSeek evaluator only, and a score produced
// under it by another model would carry a prompt version that claims a calibration it never had.
//
// services/ai.js already refuses to route evaluate to local-tutor (ai-dispatch.test.js); this suite
// pins the route-level behaviour independently of that guard — defence in depth — and pins that the
// evaluator instance 'local' is unchanged.
//
// HERMETIC: services/ai and Supabase are mocked, exactly as evaluate-consistency.test.js does.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');
const { PROMPT_VERSION, promptVersionFor } = require('../src/lib/versions');
const { PIS7_EVALUATOR_PROMPT, PIS7_LOCAL_ADDENDUM, pis7PromptFor } = require('../src/lib/prompts');
const { blankRow } = require('../src/services/shadow');

const ENV = ['EVAL_CONSISTENCY', 'EVAL_JSON_RETRIES', 'EVAL_CONSISTENCY_MAX_SUM_DELTA', 'SHADOW_EVAL_PROVIDER'];
let savedEnv, errSpy;

const scores = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4 };
const reply = (provider) => ({
  text: JSON.stringify({ ...scores, rationale: { d1: 'because' } }), inputTokens: 1000, outputTokens: 100,
  provider, model: provider === 'local-tutor' ? 'qwen-tutor' : 'deepseek-evaluator', stopReason: 'end_turn',
});
const post = () => request(app).post('/evaluate').send({ ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }], shadow: false });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  callAI.mockReset();
  resolveProviderName.mockReset();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('the prompt and its version', () => {
  test('the local addendum ships non-empty — otherwise the checks below would prove nothing', () => {
    expect(PIS7_LOCAL_ADDENDUM.length).toBeGreaterThan(0);
  });

  test("local-tutor gets the BASE prompt and the BASE version; 'local' keeps the addendum and the +local- suffix", () => {
    expect(pis7PromptFor('local-tutor')).toBe(PIS7_EVALUATOR_PROMPT);
    expect(promptVersionFor('local-tutor')).toBe(PROMPT_VERSION);
    expect(promptVersionFor('local-tutor')).not.toContain('+local-');

    expect(pis7PromptFor('local')).toBe(`${PIS7_EVALUATOR_PROMPT}\n\n${PIS7_LOCAL_ADDENDUM}`);
    expect(promptVersionFor('local')).toMatch(new RegExp(`^${PROMPT_VERSION}\\+local-[0-9a-f]{12}$`));
  });

  test('a shadow row for local-tutor would be stamped with the base prompt version', () => {
    expect(blankRow('p', 'local-tutor', 'qwen-tutor').prompt_version).toBe(PROMPT_VERSION);
    expect(blankRow('p', 'local', 'deepseek-evaluator').prompt_version).toBe(promptVersionFor('local'));
  });
});

describe('POST /evaluate with EVAL_CONSISTENCY=adaptive', () => {
  test('local-tutor: ONE call, base prompt, base version, no consistency block — the incumbent rule, not the local one', async () => {
    process.env.EVAL_CONSISTENCY = 'adaptive';
    resolveProviderName.mockResolvedValue('local-tutor');
    callAI.mockResolvedValue(reply('local-tutor'));

    const res = await post();

    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAI.mock.calls[0][0]).toMatchObject({ purpose: 'evaluate', provider: 'local-tutor', systemPrompt: PIS7_EVALUATOR_PROMPT });
    expect(res.body.prompt_version).toBe(PROMPT_VERSION);
    expect(res.body.provenance.prompt_version).toBe(PROMPT_VERSION);
    expect(res.body).not.toHaveProperty('consistency');
    expect(res.body.provenance).not.toHaveProperty('consistency');
  });

  test("'local' (the evaluator) is unchanged: the addendum prompt, the suffixed version, and the adaptive pair", async () => {
    process.env.EVAL_CONSISTENCY = 'adaptive';
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(reply('local'));

    const res = await post();

    expect(res.status).toBe(200);
    expect(callAI.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [c] of callAI.mock.calls) expect(c).toMatchObject({ provider: 'local', systemPrompt: pis7PromptFor('local') });
    expect(res.body.prompt_version).toBe(promptVersionFor('local'));
    expect(res.body).toHaveProperty('consistency');
  });
});
