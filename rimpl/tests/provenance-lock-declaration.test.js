// The lock DECLARATION in the fingerprint (#75 acceptance criterion 7: "Two scores from different
// configurations are distinguishable by fingerprint alone").
//
// The backend sends lock_declaration_sha256, a digest over the whole declared Model Lock Record
// (backend/src/services/model-lock.js lockDeclarationDigest), ONLY while a lock is in force. rimpl stamps
// it into provenance and folds it into config_fingerprint only when present.
//
// THE PINS. Every value in MASTER was produced by master 127226f6's lib/provenance.js and POST /evaluate
// route, BEFORE this change, for the inputs below (captured once by running these same inputs against
// that tree with the same stubbed AI seam). Every stored fingerprint written without a declaration
// (unlocked, or locked before this change) must stay comparable with the ones written after it, so an
// evaluation without the field must hash to exactly these.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({ upsert: async () => ({ error: null }) })), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');
const { buildProvenance } = require('../src/lib/provenance');

const W = 'a'.repeat(64);
const D1 = '1'.repeat(64);   // two lock declarations over the same weights (e.g. bf16 and fp8)
const D2 = '2'.repeat(64);
const VLLM = 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0';

const ANTHROPIC = {
  provider: 'anthropic', model: 'claude-sonnet-4-6', promptVersion: 'pis7-prompt-59561c29',
  rubricVersion: 'pis7-weights-08b0cb1a', temperature: 0, maxTokens: 4096, numCtx: null,
  weightsSha256: null, engine: null, runtime: null, consistency: null, deid: 'transcript-only-v1',
};
const LOCAL = { ...ANTHROPIC, provider: 'local', model: 'deepseek-v4-flash-dspark', promptVersion: 'pis7-prompt-59561c29+local-c5ffe572aa81' };
const SERVED = { ...LOCAL, weightsSha256: W, engine: 'vllm', runtime: VLLM, numCtx: 65536,
  consistency: { method: 'adaptive-pair', mode: 'adaptive', agree: { max_domain_delta: 1, max_sum_delta: 2 }, rule: 'pair', calls: 2 } };

const MASTER = {
  anthropicUnlocked: 'd883077fc36bdd9f',
  anthropicLocked: '695c1038374eb40f',       // weights digest only: a lock declared before this change
  localNoEngine: '28434954e7d886de',
  localServedLocked: 'dc31d0152ac55cb1',     // engine, runtime, num_ctx, consistency and weights all present
  routeLocalServedLocked: 'da08fd1bc346ac5d', // POST /evaluate, local, vLLM-reported, num_ctx 65536, weights
};

const scores = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: { d1: 'x' } };
const reply = (over = {}) => ({ text: JSON.stringify(scores), inputTokens: 500, outputTokens: 50, tokenCount: 550,
  stopReason: 'end_turn', provider: 'anthropic', model: 'claude-sonnet-4-6', ...over });
const localReply = (over = {}) => reply({ provider: 'local', model: 'deepseek-v4-flash-dspark', engine: 'vllm', runtime: VLLM, numCtx: 65536, ...over });
const evaluate = (extra = {}) => request(app).post('/evaluate')
  .send({ ple_id: 'p', transcript: [{ role: 'physician', content: 'hello' }], shadow: false, ...extra });

beforeEach(() => { callAI.mockReset(); resolveProviderName.mockReset(); });

describe('without a declaration, every fingerprint is master\'s', () => {
  test.each([
    ['anthropic, unlocked', ANTHROPIC, MASTER.anthropicUnlocked],
    ['anthropic, weights digest only', { ...ANTHROPIC, weightsSha256: W }, MASTER.anthropicLocked],
    ['local, no serving stack', LOCAL, MASTER.localNoEngine],
    ['local, everything else present', SERVED, MASTER.localServedLocked],
  ])('lib: %s', (_label, input, pinned) => {
    expect(buildProvenance(input).config_fingerprint).toBe(pinned);
    // Null, undefined and an empty string are all "no declaration".
    for (const none of [null, undefined, '']) {
      expect(buildProvenance({ ...input, lockDeclarationSha256: none }).config_fingerprint).toBe(pinned);
    }
  });

  test('lib: the slot is present and null — the honest "no lock declaration in force"', () => {
    const p = buildProvenance(ANTHROPIC);
    expect(p).toHaveProperty('lock_declaration_sha256', null);
  });

  test('route: an unlocked anthropic evaluation stamps master\'s fingerprint and a null declaration', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValue(reply());
    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(res.body.provenance).toMatchObject({ lock_declaration_sha256: null, quantization: null, config_fingerprint: MASTER.anthropicUnlocked });
    expect((await evaluate({ weights_sha256: W })).body.provenance.config_fingerprint).toBe(MASTER.anthropicLocked);
    expect((await evaluate({ weights_sha256: W, lock_declaration_sha256: null })).body.provenance.config_fingerprint).toBe(MASTER.anthropicLocked);
  });

  test('route: a served local evaluation without a declaration stamps master\'s fingerprint', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(localReply());
    const res = await evaluate({ weights_sha256: W });
    expect(res.status).toBe(200);
    expect(res.body.provenance.config_fingerprint).toBe(MASTER.routeLocalServedLocked);
  });
});

describe('with a declaration, the fingerprint tells two declarations apart', () => {
  test.each([
    ['anthropic', { ...ANTHROPIC, weightsSha256: W }],
    ['local, everything else present', SERVED],
  ])('lib (%s): same weights, different declaration → different fingerprint; same declaration → same', (_label, input) => {
    const a = buildProvenance({ ...input, lockDeclarationSha256: D1 });
    const b = buildProvenance({ ...input, lockDeclarationSha256: D2 });
    expect(a.lock_declaration_sha256).toBe(D1);
    expect(a.config_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.config_fingerprint).not.toBe(b.config_fingerprint);
    expect(a.config_fingerprint).not.toBe(buildProvenance(input).config_fingerprint);   // and not a pre-change fingerprint
    expect(buildProvenance({ ...input, lockDeclarationSha256: D1 }).config_fingerprint).toBe(a.config_fingerprint);
  });

  test('route: the declaration is stamped into provenance and fingerprinted', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(localReply());
    const one = await evaluate({ weights_sha256: W, lock_declaration_sha256: D1 });
    const two = await evaluate({ weights_sha256: W, lock_declaration_sha256: D2 });
    const oneAgain = await evaluate({ weights_sha256: W, lock_declaration_sha256: D1 });
    expect(one.status).toBe(200);
    expect(one.body.provenance).toMatchObject({ weights_sha256: W, lock_declaration_sha256: D1, locked: true });
    expect(one.body.provenance.config_fingerprint).not.toBe(MASTER.routeLocalServedLocked);
    expect(one.body.provenance.config_fingerprint).not.toBe(two.body.provenance.config_fingerprint);
    expect(oneAgain.body.provenance.config_fingerprint).toBe(one.body.provenance.config_fingerprint);
  });

  test('route: the digest is never sent to the model — it is provenance, not prompt', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValue(reply());
    await evaluate({ weights_sha256: W, lock_declaration_sha256: D1 });
    expect(JSON.stringify(callAI.mock.calls)).not.toContain(D1);
  });

  test.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['not hex', 'g'.repeat(64)],
    ['an empty string', ''],
  ])('route: a malformed declaration digest (%s) is a 400 and nothing is scored', async (_label, value) => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValue(reply());
    const res = await evaluate({ weights_sha256: W, lock_declaration_sha256: value });
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });
});

describe('quantization: passed through when a transport reports it, which none does today', () => {
  test('route: neither current transport reports it, so it is null and the fingerprint unchanged', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(localReply());
    const res = await evaluate({ weights_sha256: W });
    expect(res.body.provenance.quantization).toBeNull();
    expect(res.body.provenance.config_fingerprint).toBe(MASTER.routeLocalServedLocked);
  });

  test('route: a transport that did report it would have it stamped and fingerprinted', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValue(localReply({ quantization: 'fp8' }));
    const res = await evaluate({ weights_sha256: W });
    expect(res.body.provenance.quantization).toBe('fp8');
    expect(res.body.provenance.config_fingerprint).not.toBe(MASTER.routeLocalServedLocked);
  });
});
