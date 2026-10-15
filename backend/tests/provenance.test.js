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

  // EVAL_DECODING moved out of routes/evaluate.js into rimpl/src/lib/decoding.js (package-free, so the
  // model manifest can record it on a bare checkout). The pins follow it: ONE definition there, and the
  // route reading it for both the call and the record.
  const rimplSrc = (rel) => require('fs').readFileSync(require('path').join(__dirname, '../../rimpl/src', rel), 'utf8');

  test('the decoding parameters recorded are the ones the evaluator actually sends', () => {
    // Not a module constant restated: routes/evaluate.js reads EVAL_DECODING for both the call and
    // the record, so the two cannot drift.
    const { EVAL_DECODING } = require('../../rimpl/src/lib/decoding');
    expect(EVAL_DECODING).toEqual({ temperature: 0, maxTokens: 4096 });
    expect(Object.isFrozen(EVAL_DECODING)).toBe(true);
    expect(rimplSrc('lib/decoding.js')).toMatch(/const EVAL_DECODING = Object\.freeze\(\{ temperature: 0, maxTokens: 4096 \}\);/);
    const src = rimplSrc('routes/evaluate.js');
    expect(src).toMatch(/const \{ EVAL_DECODING \} = require\('\.\.\/lib\/decoding'\);/);
    expect(src).not.toMatch(/const EVAL_DECODING =/);   // one definition, not a second copy in the route
    expect(src).toMatch(/maxTokens: EVAL_DECODING\.maxTokens/);
    expect(src).toMatch(/temperature: EVAL_DECODING\.temperature/);
    expect(src).toMatch(/temperature: EVAL_DECODING\.temperature, maxTokens: EVAL_DECODING\.maxTokens/);
  });

  test('the shadow evaluator sends the same decoding — the candidate is measured under the instrument\'s', () => {
    const { EVAL_DECODING, SHADOW_DECODING } = require('../../rimpl/src/lib/decoding');
    expect(SHADOW_DECODING.temperature).toBe(EVAL_DECODING.temperature);
    expect(SHADOW_DECODING.maxTokens.default).toBe(EVAL_DECODING.maxTokens);
    expect(rimplSrc('services/shadow.js')).toMatch(/temperature: SHADOW_DECODING\.temperature,/);
  });

  test('temperature is 0 — a sampled scoring instrument is not reproducible', () => {
    expect(require('../../rimpl/src/lib/decoding').EVAL_DECODING.temperature).toBe(0);
    expect(rimplSrc('lib/decoding.js')).toMatch(/temperature: 0,/);
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
    // ...and the declared checksum (with the declaration digest) is read per call, so a mid-pilot
    // re-declaration is visible as a fingerprint change in the data rather than hidden by a cached value.
    expect(src).toMatch(/await evaluationLockStamp\(\)/);
  });

  test('the checksum reaches RIMPL — a value read but not forwarded would stamp nothing', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/rimpl-client.js'), 'utf8');
    expect(src).toMatch(/weights_sha256: weights_sha256 \?\? null/);
    // The declaration digest too, and only when there is one (#75 criterion 7).
    expect(src).toMatch(/\.\.\.\(lock_declaration_sha256 \? \{ lock_declaration_sha256 \} : \{\}\)/);
  });
});

describe('configFingerprint in isolation', () => {
  test('is stable, short, and hex', () => {
    const f = configFingerprint({ provider: 'x', model: 'y' });
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(configFingerprint({ provider: 'x', model: 'y' })).toBe(f);
  });
});
