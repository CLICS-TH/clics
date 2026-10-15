// config_fingerprint after the serving stack was folded in (#75 gap 1; lib/provenance.js), and the two
// provenance fields the evaluator route now fills from the local transport (engine/runtime, num_ctx).
// A LOCAL row's fingerprint therefore moves in two cases: the server reports a system_fingerprint, or
// LOCAL_AI_NUM_CTX is set (decoding.num_ctx was always null before; it is now the value sent).
//
// THE ANTHROPIC PINS. The values below were produced by master 80200434's lib/provenance.js — the
// module BEFORE this change — and by its POST /evaluate route, for the inputs shown (computed once from
// `git archive 80200434 rimpl/src`, the same stubbed AI seam on both trees). Production has scored with
// anthropic only, and every one of those stored fingerprints must stay comparable with the ones written
// after this change, so an Anthropic row must hash to exactly these.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({ upsert: async () => ({ error: null }) })), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');
const { buildProvenance } = require('../src/lib/provenance');

const ANTHROPIC = {
  provider: 'anthropic', model: 'claude-sonnet-4-6', promptVersion: 'pis7-prompt-59561c29',
  rubricVersion: 'pis7-weights-08b0cb1a', temperature: 0, maxTokens: 4096, numCtx: null,
  weightsSha256: null, engine: null, runtime: null, consistency: null, deid: 'transcript-only-v1',
};
const MASTER = { unlocked: 'd883077fc36bdd9f', locked: '695c1038374eb40f', localNoEngine: '28434954e7d886de' };
const LOCKED_SHA = 'a'.repeat(64);

const scores = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: { d1: 'x' } };
const reply = (over = {}) => ({ text: JSON.stringify(scores), inputTokens: 500, outputTokens: 50, tokenCount: 550,
  stopReason: 'end_turn', provider: 'anthropic', model: 'claude-sonnet-4-6', ...over });
const evaluate = (extra = {}) => request(app).post('/evaluate')
  .send({ ple_id: 'p', transcript: [{ role: 'physician', content: 'hello' }], shadow: false, ...extra });

beforeEach(() => { callAI.mockReset(); resolveProviderName.mockReset(); });

describe('an Anthropic row hashes exactly as it did on master', () => {
  test('lib: unlocked and locked', () => {
    expect(buildProvenance(ANTHROPIC).config_fingerprint).toBe(MASTER.unlocked);
    expect(buildProvenance({ ...ANTHROPIC, weightsSha256: LOCKED_SHA }).config_fingerprint).toBe(MASTER.locked);
  });

  test('route: POST /evaluate on the incumbent path stamps master\'s fingerprint, with num_ctx/engine/runtime null', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValue(reply());
    const unlocked = await evaluate();
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.provenance).toMatchObject({
      provider: 'anthropic', model: 'claude-sonnet-4-6', prompt_version: 'pis7-prompt-59561c29', rubric_version: 'pis7-weights-08b0cb1a',
      decoding: { temperature: 0, max_tokens: 4096, top_p: null, seed: null, num_ctx: null },
      engine: null, quantization: null, runtime: null, locked: false, config_fingerprint: MASTER.unlocked,
    });
    const locked = await evaluate({ weights_sha256: LOCKED_SHA });
    expect(locked.body.provenance.config_fingerprint).toBe(MASTER.locked);
  });
});

describe('a local row now carries its serving stack in the fingerprint', () => {
  const LOCAL = { ...ANTHROPIC, provider: 'local', model: 'deepseek-v4-flash-dspark', promptVersion: 'pis7-prompt-59561c29+local-c5ffe572aa81' };

  test('without an engine it is unchanged too; with one it moves', () => {
    expect(buildProvenance(LOCAL).config_fingerprint).toBe(MASTER.localNoEngine);
    const served = buildProvenance({ ...LOCAL, engine: 'vllm', runtime: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0' });
    expect(served.config_fingerprint).not.toBe(MASTER.localNoEngine);
    expect(served.config_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('route: the engine, runtime and num_ctx the transport reported are recorded and fingerprinted', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(reply({ provider: 'local', model: 'deepseek-v4-flash-dspark', engine: 'vllm',
      runtime: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0', numCtx: 65536 }));
    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(res.body.provenance).toMatchObject({ engine: 'vllm', runtime: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0' });
    // #75: num_ctx was always null in provenance although the transport sent it.
    expect(res.body.provenance.decoding.num_ctx).toBe(65536);
    const without = buildProvenance({ ...LOCAL, engine: 'vllm', runtime: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0' });
    expect(res.body.provenance.config_fingerprint).not.toBe(without.config_fingerprint);
  });

  test('num_ctx alone moves a local row\'s fingerprint too (no engine reported)', () => {
    expect(buildProvenance({ ...LOCAL, numCtx: 32768 }).config_fingerprint).not.toBe(MASTER.localNoEngine);
    expect(buildProvenance({ ...LOCAL, numCtx: null }).config_fingerprint).toBe(MASTER.localNoEngine);
  });
});
