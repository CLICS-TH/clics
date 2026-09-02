// POST /evaluate under self-consistency (services/consistency.js) — the route-level contract:
//   * the provider is resolved FIRST and PINNED into every call (routes/chat.js's citation-retry precedent);
//   * anthropic: one call, no `consistency` key, prompt_version = PROMPT_VERSION — the response is
//     byte-identical to before this existed, whatever EVAL_CONSISTENCY says;
//   * local + EVAL_CONSISTENCY=adaptive: 2 or 3 calls, tokens billed = call 1 (D21), `consistency` in
//     the body and in provenance (and in the fingerprint); local without the env: one call.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');
const { PROMPT_VERSION, promptVersionFor } = require('../src/lib/versions');
const { PIS7_EVALUATOR_PROMPT, pis7PromptFor } = require('../src/lib/prompts');
const { QueueFullError } = require('../src/services/providers/runtime');

const ENV = ['EVAL_CONSISTENCY', 'EVAL_JSON_RETRIES', 'SHADOW_EVAL_PROVIDER'];
let savedEnv;
let errSpy;

const V = (d7) => ({ d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7 });
const reply = (scores, provider, input, output) => ({
  text: JSON.stringify({ ...scores, rationale: { d1: 'because' } }), inputTokens: input, outputTokens: output,
  provider, model: provider === 'local' ? 'qwen-test' : 'claude-sonnet-4-6', stopReason: 'end_turn',
});
const local = (d7, input = 1000, output = 100) => reply(V(d7), 'local', input, output);
const anthropic = (d7 = 4) => reply(V(d7), 'anthropic', 500, 50);
const garbage = { text: 'I cannot score this.', inputTokens: 7, outputTokens: 3, provider: 'local', model: 'qwen-test', stopReason: 'end_turn' };
const body = { ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }], shadow: false };
const post = () => request(app).post('/evaluate').send(body);

// The response keys before this change, in order — the incumbent path must still produce exactly these.
const HISTORICAL_KEYS = ['ple_id', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'composite_score', 'domain_rationale',
  'model_version', 'prompt_version', 'rubric_version', 'provenance', 'input_tokens', 'output_tokens', 'provider'];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  callAI.mockReset();
  resolveProviderName.mockReset();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
describe('the incumbent (anthropic) path is unchanged', () => {
  test('one call, pinned to anthropic with the base prompt; no consistency key; prompt_version = PROMPT_VERSION', async () => {
    process.env.EVAL_CONSISTENCY = 'adaptive';                 // must make no difference here
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce(anthropic());

    const res = await post();

    expect(res.status).toBe(200);
    expect(resolveProviderName).toHaveBeenCalledWith('evaluate');
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAI.mock.calls[0][0]).toMatchObject({ purpose: 'evaluate', provider: 'anthropic', systemPrompt: PIS7_EVALUATOR_PROMPT });
    expect(Object.keys(res.body)).toEqual(HISTORICAL_KEYS);
    expect(res.body).not.toHaveProperty('consistency');
    expect(res.body.provenance).not.toHaveProperty('consistency');
    expect(res.body.prompt_version).toBe(PROMPT_VERSION);
    expect(res.body.provenance.prompt_version).toBe(PROMPT_VERSION);
    expect(res.body.input_tokens).toBe(500);
    expect(res.body.output_tokens).toBe(50);
    expect(res.body.model_version).toBe('CCME_LLM_v8.0+claude-sonnet-4-6');
  });

  test('an unparseable reply is a 502 after ONE call — no re-ask on the incumbent, even with EVAL_JSON_RETRIES=2', async () => {
    process.env.EVAL_JSON_RETRIES = '2';
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce({ ...garbage, provider: 'anthropic' }).mockResolvedValueOnce(anthropic());
    const res = await post();
    expect(res.status).toBe(502);
    expect(callAI).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('local + EVAL_CONSISTENCY=adaptive', () => {
  beforeEach(() => {
    process.env.EVAL_CONSISTENCY = 'adaptive';
    resolveProviderName.mockResolvedValue('local');
  });

  test('agreeing pair: two calls, every one pinned to local with the local prompt; tokens = call 1; consistency in body AND provenance', async () => {
    callAI.mockResolvedValueOnce(local(4, 1000, 100)).mockResolvedValueOnce(local(3, 1001, 101));

    const res = await post();

    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    for (const [call] of callAI.mock.calls) {
      expect(call.provider).toBe('local');
      expect(call.systemPrompt).toBe(pis7PromptFor('local'));
      expect(call.purpose).toBe('evaluate');
    }
    expect(res.body.d7).toBe(4);                                          // final = c1
    expect(res.body.input_tokens).toBe(1000);                             // billed: call 1 only (D21)
    expect(res.body.output_tokens).toBe(100);
    expect(res.body.consistency).toMatchObject({
      method: 'self-consistency', mode: 'adaptive', rule: 'first-of-agreeing-pair', calls: 2, max_delta: 1,
      json_retries: 0, extra_input_tokens: 1001, extra_output_tokens: 101,
    });
    expect(res.body.provenance.consistency).toEqual(res.body.consistency);
    expect(res.body.prompt_version).toBe(promptVersionFor('local'));
    expect(res.body.provider).toBe('local');
    expect(res.body.model_version).toBe('CCME_LLM_v8.0+qwen-test');
  });

  test('disagreement on one domain by 2: three calls, per-domain median', async () => {
    callAI.mockResolvedValueOnce(local(4)).mockResolvedValueOnce(local(2)).mockResolvedValueOnce(local(3));
    const res = await post();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(res.body.d7).toBe(3);
    expect(res.body.consistency).toMatchObject({ rule: 'median-of-3', calls: 3, max_delta: 2 });
    expect(res.body.consistency.per_call_scores).toEqual([[3, 4, 3, 2, 5, 1, 4], [3, 4, 3, 2, 5, 1, 2], [3, 4, 3, 2, 5, 1, 3]]);
  });

  test('the fingerprint moves with the consistency CONFIGURATION, not with the run\'s outcome', async () => {
    callAI.mockResolvedValueOnce(local(4)).mockResolvedValueOnce(local(4));
    const pair = (await post()).body.provenance;
    callAI.mockResolvedValueOnce(local(4)).mockResolvedValueOnce(local(2)).mockResolvedValueOnce(local(3));
    const median = (await post()).body.provenance;
    delete process.env.EVAL_CONSISTENCY;
    callAI.mockResolvedValueOnce(local(4));
    const single = (await post()).body.provenance;

    expect(pair.config_fingerprint).toBe(median.config_fingerprint);          // same configuration
    expect(single.config_fingerprint).not.toBe(pair.config_fingerprint);      // adaptive vs none
    expect(single).not.toHaveProperty('consistency');
  });

  test('an unparseable first reply is re-asked (EVAL_JSON_RETRIES default 2) and the run still succeeds', async () => {
    callAI.mockResolvedValueOnce(garbage).mockResolvedValueOnce(local(4, 1000, 100)).mockResolvedValueOnce(local(4, 1001, 101));
    const res = await post();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(3);
    expect(res.body.consistency).toMatchObject({ calls: 2, json_retries: 1, rule: 'first-of-agreeing-pair' });
    expect(res.body.input_tokens).toBe(7);                                     // call 1 — whatever it returned — is the billed one
    expect(res.body.consistency.extra_input_tokens).toBe(2001);
  });

  test('EVAL_JSON_RETRIES=0: an unparseable reply is a 502 at once', async () => {
    process.env.EVAL_JSON_RETRIES = '0';
    callAI.mockResolvedValueOnce(garbage).mockResolvedValueOnce(local(4));
    const res = await post();
    expect(res.status).toBe(502);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/\[RIMPL evaluate\] (invalid JSON|out-of-range)/));
  });

  test('a queue_full on the SECOND call propagates as 503 — the evaluation is not served half-reconciled', async () => {
    callAI.mockResolvedValueOnce(local(4))
      .mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'background', maxQueue: 2, retryAfterMs: 30000 }));
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('queue_full');
    expect(callAI).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
describe('local without the env, and resolution failures', () => {
  test('local + EVAL_CONSISTENCY unset → one call, no consistency key, tokens = the call', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValueOnce(local(4, 1000, 100)).mockResolvedValueOnce(local(4));
    const res = await post();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAI.mock.calls[0][0].provider).toBe('local');
    expect(res.body).not.toHaveProperty('consistency');
    expect(res.body.provenance).not.toHaveProperty('consistency');
    expect(res.body.input_tokens).toBe(1000);
  });

  test('EVAL_CONSISTENCY with any other value is off', async () => {
    process.env.EVAL_CONSISTENCY = 'always';
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValueOnce(local(4));
    const res = await post();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body).not.toHaveProperty('consistency');
  });

  test('a provider that cannot be resolved (unknown name) is a 500 with NO model call', async () => {
    resolveProviderName.mockRejectedValue(new Error('Unknown AI provider "antropic" (from app_settings.ai_provider_evaluate / AI_PROVIDER_EVALUATE / AI_PROVIDER). Valid: anthropic, local'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(callAI).not.toHaveBeenCalled();
  });
});
