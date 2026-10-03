// Model Lock provenance (CREC082 Primary Evaluator Model Lock Record V1.0, Protocol §10.2).
//
// The lock's whole purpose is that a score can be traced to the exact configuration that produced
// it. That only works if the provenance is stamped at the moment of scoring and is honest about the
// part the system cannot measure.
jest.mock('../src/lib/supabase', () => ({ supabase: { from: () => ({}) } }));
const { buildProvenance, configFingerprint } = require('../../rimpl/src/lib/provenance');

const base = {
  provider: 'local', model: 'qwen3.6-custom',
  promptVersion: 'p-v3', rubricVersion: 'r-v2',
  temperature: 0, maxTokens: 4096,
};

describe('the fingerprint identifies a configuration', () => {
  test('property order does not change it', () => {
    const a = buildProvenance({ ...base, weightsSha256: 'abc' });
    const b = buildProvenance({ weightsSha256: 'abc', maxTokens: 4096, temperature: 0,
      rubricVersion: 'r-v2', promptVersion: 'p-v3', model: 'qwen3.6-custom', provider: 'local' });
    expect(a.config_fingerprint).toBe(b.config_fingerprint);
  });

  test.each([
    ['a different model', { model: 'qwen3.6-other' }],
    ['a different temperature', { temperature: 0.2 }],
    ['a different max_tokens', { maxTokens: 2048 }],
    ['a different prompt version', { promptVersion: 'p-v4' }],
    ['a different rubric version', { rubricVersion: 'r-v3' }],
    ['a different provider', { provider: 'anthropic' }],
    ['a re-declared weights checksum', { weightsSha256: 'def' }],
  ])('%s moves the fingerprint', (_label, change) => {
    const a = buildProvenance({ ...base, weightsSha256: 'abc' });
    const b = buildProvenance({ ...base, weightsSha256: 'abc', ...change });
    expect(b.config_fingerprint).not.toBe(a.config_fingerprint);
  });
});

describe('honest about what it can and cannot measure', () => {
  test('with no declared checksum the score says NOT LOCKED rather than implying one', () => {
    // The weights file sits on the DGX and is not readable over an inference API, so this cannot be
    // measured — only declared. Silence here would read as "locked" to anyone scanning the column.
    const p = buildProvenance(base);
    expect(p.weights_sha256).toBeNull();
    expect(p.locked).toBe(false);
  });

  test('with a declared checksum it is stamped and the score reads as locked', () => {
    const p = buildProvenance({ ...base, weightsSha256: 'a'.repeat(64) });
    expect(p.weights_sha256).toBe('a'.repeat(64));
    expect(p.locked).toBe(true);
  });

  test('the decoding parameters recorded are the ones the evaluator actually sends', () => {
    // The REQUEST still reads EVAL_DECODING. The RECORD reads what the provider reports it sent
    // (`decoding` on the call result), not the request: claude-sonnet-5-5 rejects a non-default
    // temperature, so the anthropic provider sends none and the record must say null there, not 0.
    // Behaviour is covered end to end in rimpl/tests/anthropic-request.test.js.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../rimpl/src/routes/evaluate.js'), 'utf8');
    expect(src).toMatch(/const EVAL_DECODING = \{ temperature: 0, maxTokens: 4096 \}/);
    expect(src).toMatch(/maxTokens: EVAL_DECODING\.maxTokens/);
    expect(src).toMatch(/temperature: EVAL_DECODING\.temperature/);   // the request
    expect(src).toMatch(/const sent = first\?\.decoding \?\? \{\};/);
    expect(src).toMatch(/temperature: sent\.temperature \?\? null, maxTokens: EVAL_DECODING\.maxTokens/);
    expect(src).not.toMatch(/temperature: EVAL_DECODING\.temperature, maxTokens: EVAL_DECODING\.maxTokens/);
  });

  test('temperature is 0 — a sampled scoring instrument is not reproducible', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../rimpl/src/routes/evaluate.js'), 'utf8');
    expect(src).toMatch(/temperature: 0,/);
  });

  test('every §10.2 field has a slot, present even when unfilled', () => {
    const p = buildProvenance(base);
    for (const f of ['provider', 'model', 'prompt_version', 'rubric_version', 'weights_sha256', 'engine', 'quantization', 'runtime', 'locked', 'config_fingerprint']) {
      expect(p).toHaveProperty(f);
    }
    for (const d of ['temperature', 'max_tokens', 'top_p', 'seed', 'num_ctx']) {
      expect(p.decoding).toHaveProperty(d);
    }
  });
});

describe('the backend stamps it onto the score', () => {
  test('persistEvaluation writes provenance through to ai_evaluations', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/ple-evaluation.js'), 'utf8');
    expect(src).toMatch(/provenance: result\.provenance/);
    // ...and the declared checksum is read per call, so a mid-pilot re-declaration is visible as a
    // fingerprint change in the data rather than being hidden by a cached value.
    expect(src).toMatch(/await evaluatorWeightsSha256\(\)/);
  });

  test('the checksum reaches RIMPL — a value read but not forwarded would stamp nothing', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/rimpl-client.js'), 'utf8');
    expect(src).toMatch(/weights_sha256: weights_sha256 \?\? null/);
  });
});

describe('configFingerprint in isolation', () => {
  test('is stable, short, and hex', () => {
    const f = configFingerprint({ provider: 'x', model: 'y' });
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(configFingerprint({ provider: 'x', model: 'y' })).toBe(f);
  });
});
