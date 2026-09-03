// lib/provenance.js with a `consistency` block (services/consistency.js).
//
// The fixtures below are the fingerprints the module at the PREVIOUS commit produced for the same
// inputs — computed once from `git show HEAD:rimpl/src/lib/provenance.js` before this change. An
// evaluation WITHOUT a consistency block must still hash to them: every fingerprint the pilot has
// stored so far has to stay comparable with the ones written after this change.
const { buildProvenance, configFingerprint, canonicalConsistency } = require('../src/lib/provenance');

const base = {
  provider: 'local', model: 'qwen3.6-custom',
  promptVersion: 'p-v3', rubricVersion: 'r-v2',
  temperature: 0, maxTokens: 4096, weightsSha256: 'abc',
};
const block = (over = {}) => ({
  method: 'self-consistency', mode: 'adaptive', rule: 'first-of-agreeing-pair', calls: 2, max_delta: 1, sum_delta: 1,
  agree: { max_domain_delta: 1, max_sum_delta: 0 },
  per_call_scores: [[3, 4, 3, 2, 5, 1, 4], [3, 4, 3, 2, 5, 1, 3]], json_retries: 0,
  extra_input_tokens: 1001, extra_output_tokens: 101, latency_ms: 140000, ...over,
});

describe('without a consistency block — byte-identical to the pre-change module', () => {
  test('the local fixture', () => {
    expect(buildProvenance(base).config_fingerprint).toBe('4d011b19f3020b78');
  });

  test('the anthropic fixture (no declared checksum)', () => {
    const p = buildProvenance({ provider: 'anthropic', model: 'claude-sonnet-4-6', promptVersion: 'pis7-prompt-deadbeef',
      rubricVersion: 'pis7-weights-cafebabe', temperature: 0, maxTokens: 4096 });
    expect(p.config_fingerprint).toBe('6783fc1d7c068e49');
  });

  test('configFingerprint in isolation', () => {
    expect(configFingerprint({ provider: 'x', model: 'y' })).toBe('c46bfe6c8e158c3d');
  });

  test.each([null, undefined])('consistency: %s puts no key on the object', (v) => {
    const p = buildProvenance({ ...base, consistency: v });
    expect(p).not.toHaveProperty('consistency');
    expect(p.config_fingerprint).toBe('4d011b19f3020b78');
  });
});

describe('with a consistency block', () => {
  test('the block travels in the object and the fingerprint differs from the same configuration without it', () => {
    const p = buildProvenance({ ...base, consistency: block() });
    expect(p.consistency).toEqual(block());
    expect(p.config_fingerprint).not.toBe('4d011b19f3020b78');
    expect(p.config_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the fingerprint hashes the CONFIGURATION half only: pair vs median-of-3 under the same mode hash the same', () => {
    const pair = buildProvenance({ ...base, consistency: block() });
    const median = buildProvenance({ ...base, consistency: block({ rule: 'median-of-3', calls: 3, max_delta: 2, json_retries: 1, latency_ms: 210000,
      per_call_scores: [[3, 4, 3, 2, 5, 1, 4], [3, 4, 3, 2, 5, 1, 2], [3, 4, 3, 2, 5, 1, 3]] }) });
    expect(median.config_fingerprint).toBe(pair.config_fingerprint);
  });

  test('a different mode or method IS a different configuration', () => {
    const a = buildProvenance({ ...base, consistency: block() });
    expect(buildProvenance({ ...base, consistency: block({ mode: 'off' }) }).config_fingerprint).not.toBe(a.config_fingerprint);
    expect(buildProvenance({ ...base, consistency: block({ mode: 'median3' }) }).config_fingerprint).not.toBe(a.config_fingerprint);
    expect(buildProvenance({ ...base, consistency: block({ method: 'majority-vote' }) }).config_fingerprint).not.toBe(a.config_fingerprint);
  });

  test('the agreement thresholds are configuration: a different sum bound moves the fingerprint, a different sum_delta OUTCOME does not', () => {
    const a = buildProvenance({ ...base, consistency: block() });
    expect(buildProvenance({ ...base, consistency: block({ agree: { max_domain_delta: 1, max_sum_delta: 2 } }) }).config_fingerprint).not.toBe(a.config_fingerprint);
    expect(buildProvenance({ ...base, consistency: block({ sum_delta: 5, max_delta: 1 }) }).config_fingerprint).toBe(a.config_fingerprint);
  });

  test('property order of the block does not matter', () => {
    const b = block();
    const reversed = Object.fromEntries(Object.entries(b).reverse());
    expect(buildProvenance({ ...base, consistency: reversed }).config_fingerprint)
      .toBe(buildProvenance({ ...base, consistency: b }).config_fingerprint);
  });

  test('canonicalConsistency keeps method, mode and the agreement thresholds only', () => {
    expect(canonicalConsistency(block())).toEqual({ method: 'self-consistency', mode: 'adaptive', agree: { max_domain_delta: 1, max_sum_delta: 0 } });
    expect(canonicalConsistency({})).toEqual({ method: null, mode: null, agree: { max_domain_delta: null, max_sum_delta: null } });
  });
});
