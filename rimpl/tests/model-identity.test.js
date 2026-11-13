// Model identity (ADR 0012, #430). CME cannot give a weights digest for the on-prem evaluator, so a lock
// may name it by model id + server system fingerprint. Two things must then hold:
//   1. The local evaluator's prompt label carries the CONFIGURED model id, and the served row and its
//      shadow row carry the same label, so rows from two models are never pooled into one verdict.
//   2. Provenance records the identity basis, folds it into the fingerprint only when present, and
//      counts a declaration-only lock as locked.
const mockCallAI = jest.fn();
const mockResolve = jest.fn();
const mockCallProvider = jest.fn();
jest.mock('../src/services/ai', () => {
  const actual = jest.requireActual('../src/services/ai');
  return {
    ...actual,
    callAI: (...a) => mockCallAI(...a),
    resolveProviderName: (...a) => mockResolve(...a),
    callProvider: (...a) => mockCallProvider(...a),
  };
});
const mockUpsert = jest.fn(async () => ({ error: null }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ upsert: (...a) => mockUpsert(...a) }), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { PROMPT_VERSION, promptVersionFor } = require('../src/lib/versions');
const { buildProvenance, configFingerprint } = require('../src/lib/provenance');
const { runShadowEvaluation } = require('../src/services/shadow');

const MODEL = 'DeepSeek-V4.1-Flash-1017';
const D1 = '1'.repeat(64);
const scores = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: { d1: 'x' } };
const reply = (over = {}) => ({ text: JSON.stringify(scores), inputTokens: 500, outputTokens: 50, tokenCount: 550,
  stopReason: 'end_turn', provider: 'local', model: MODEL, ...over });
const evaluate = (extra = {}) => request(app).post('/evaluate')
  .send({ ple_id: 'p', transcript: [{ role: 'physician', content: 'hello' }], shadow: false, ...extra });

const ENV = ['LOCAL_AI_MODEL', 'SHADOW_EVAL_PROVIDER', 'SHADOW_EVAL_CONSISTENCY', 'EVAL_CONSISTENCY'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  mockCallAI.mockReset(); mockResolve.mockReset(); mockCallProvider.mockReset();
  mockUpsert.mockReset().mockResolvedValue({ error: null });
});

describe('promptVersionFor: the model id rides on the local label only', () => {
  test('local + model = the current label, "@", the model id', () => {
    expect(promptVersionFor('local', undefined, MODEL)).toBe(`${promptVersionFor('local')}@${MODEL}`);
    expect(promptVersionFor('local', 'ADDENDUM', MODEL)).toBe(`${promptVersionFor('local', 'ADDENDUM')}@${MODEL}`);
    expect(promptVersionFor('local', '', MODEL)).toBe(`${PROMPT_VERSION}@${MODEL}`);
  });

  test('no model configured: the label is unchanged', () => {
    for (const none of [null, undefined, '']) expect(promptVersionFor('local', undefined, none)).toBe(promptVersionFor('local'));
  });

  test.each(['anthropic', 'local-tutor', undefined])('%s is byte-identical whatever model is passed', (provider) => {
    expect(promptVersionFor(provider, undefined, MODEL)).toBe(PROMPT_VERSION);
  });
});

describe('served and shadow rows stamp the same model-bearing label', () => {
  test('POST /evaluate on local stamps the configured model id; anthropic does not', async () => {
    process.env.LOCAL_AI_MODEL = MODEL;
    mockResolve.mockResolvedValue('local');
    mockCallAI.mockResolvedValue(reply({ model: 'what-the-server-said' }));
    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(res.body.prompt_version).toBe(`${promptVersionFor('local')}@${MODEL}`);
    expect(res.body.provenance.prompt_version).toBe(res.body.prompt_version);

    mockResolve.mockResolvedValue('anthropic');
    mockCallAI.mockResolvedValue(reply({ provider: 'anthropic', model: 'claude-sonnet-4-6' }));
    expect((await evaluate()).body.prompt_version).toBe(PROMPT_VERSION);
  });

  test('a local shadow row carries the label a served local evaluation would', async () => {
    process.env.LOCAL_AI_MODEL = MODEL;
    process.env.SHADOW_EVAL_PROVIDER = 'local';
    mockCallProvider.mockResolvedValue(reply());
    const r = await runShadowEvaluation({ pleId: 'p', transcriptText: 'Physician: hi', servedProvider: 'anthropic' });
    expect(r).toMatchObject({ persisted: true, provider: 'local' });

    mockResolve.mockResolvedValue('local');
    mockCallAI.mockResolvedValue(reply());
    const served = await evaluate();
    expect(mockUpsert.mock.calls[0][0].prompt_version).toBe(served.body.prompt_version);
    expect(served.body.prompt_version).toContain(`@${MODEL}`);
  });
});

describe('provenance: identity_basis', () => {
  const BASE = {
    provider: 'local', model: MODEL, promptVersion: `${promptVersionFor('local')}@${MODEL}`,
    rubricVersion: 'pis7-weights-08b0cb1a', temperature: 0, maxTokens: 4096, numCtx: null,
    engine: 'vllm', runtime: 'vllm-x', deid: 'transcript-only-v1',
  };

  test('a lock by model identity: no weights digest, still locked, basis recorded and fingerprinted', () => {
    const p = buildProvenance({ ...BASE, lockDeclarationSha256: D1, identityBasis: 'model_id+system_fingerprint' });
    expect(p).toMatchObject({ weights_sha256: null, locked: true, identity_basis: 'model_id+system_fingerprint' });
    const without = buildProvenance({ ...BASE, lockDeclarationSha256: D1 });
    expect(p.config_fingerprint).not.toBe(without.config_fingerprint);
    expect(buildProvenance({ ...BASE, lockDeclarationSha256: D1, identityBasis: 'weights_sha256' }).config_fingerprint)
      .not.toBe(p.config_fingerprint);
  });

  test('absent: the slot is null and the fingerprint is the one computed without the key', () => {
    const p = buildProvenance(BASE);
    expect(p.identity_basis).toBeNull();
    expect(p.locked).toBe(false);
    const { identity_basis: _drop, config_fingerprint: fp, ...rest } = p;
    expect(fp).toBe(configFingerprint(rest));
  });

  test('route: identity_basis is accepted, stamped, and never sent to the model', async () => {
    process.env.LOCAL_AI_MODEL = MODEL;
    mockResolve.mockResolvedValue('local');
    mockCallAI.mockResolvedValue(reply());
    const res = await evaluate({ lock_declaration_sha256: D1, identity_basis: 'model_id+system_fingerprint' });
    expect(res.status).toBe(200);
    expect(res.body.provenance).toMatchObject({ identity_basis: 'model_id+system_fingerprint', locked: true, weights_sha256: null });
    expect(JSON.stringify(mockCallAI.mock.calls)).not.toContain('model_id+system_fingerprint');
  });

  test('route: an unknown identity basis is a 400 and nothing is scored', async () => {
    mockResolve.mockResolvedValue('local');
    mockCallAI.mockResolvedValue(reply());
    const res = await evaluate({ lock_declaration_sha256: D1, identity_basis: 'vibes' });
    expect(res.status).toBe(400);
    expect(mockCallAI).not.toHaveBeenCalled();
  });
});
