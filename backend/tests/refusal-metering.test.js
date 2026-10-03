// A safeguard refusal (rimpl 422 'refused') delivers nothing but WAS billed by the provider. Every
// caller must meter the usage rimpl reports, then fail exactly as it did before for a deterministic
// error. Never a retry on another model. (The chat turn's own metering is in refusal-chat-turn.test.js.)
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));
const mockRefusal = () => Object.assign(new Error('RIMPL /x error: 422'), {
  status: 422, code: 'refused', category: 'bio',
  usage: { input_tokens: 130000, output_tokens: 5, provider: 'anthropic' },
});
const mockEvaluate = jest.fn(async () => { throw mockRefusal(); });
const mockCriteria = jest.fn(async () => { throw mockRefusal(); });
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluate: (...a) => mockEvaluate(...a),
  rimplEvaluateCriteria: (...a) => mockCriteria(...a),
  isDeterministicRimplError: (e) => e && [400, 401, 403, 413, 422, 502].includes(e.status),
}));
const mockAccrue = jest.fn(async () => ({ cost: 0, error: null }));
jest.mock('../src/lib/usage', () => ({ accrueUsage: (...a) => mockAccrue(...a) }));
jest.mock('../src/lib/pii-map', () => ({ persistPiiMap: jest.fn(async () => {}) }));

const { triggerEvaluation } = require('../src/services/ple-evaluation');
const { finalizeScreening } = require('../src/services/ple-finalize');
const { costUsd } = require('../src/lib/pricing');

let warn;
beforeEach(() => { mockAccrue.mockClear(); mockEvaluate.mockClear(); mockCriteria.mockClear(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

test('PIS-7 evaluation: a refusal is metered at the provider rate, tried ONCE, then rethrown', async () => {
  const err = await triggerEvaluation('ple1', [{ role: 'physician', content: 'x' }], 'doc1').catch((e) => e);
  expect(err.code).toBe('refused');
  expect(mockEvaluate).toHaveBeenCalledTimes(1);   // deterministic: no in-process retry
  expect(mockAccrue).toHaveBeenCalledTimes(1);
  expect(mockAccrue).toHaveBeenCalledWith('doc1', 130000, 5, costUsd(130000, 5, 'anthropic'));
  expect(warn.mock.calls.flat().join(' ')).toMatch(/category bio/);
});

test('tier-2 criteria: a refusal is metered, then the existing failure path (rethrow)', async () => {
  const err = await finalizeScreening({
    pleId: 'c1', physicianId: 'p1', transcript: [{ role: 'physician', content: 'x' }],
    tier1: { c1: true, c2: true, c3: true }, patient_ref: null, ple: {},
  }).catch((e) => e);
  expect(err.code).toBe('refused');
  expect(mockCriteria).toHaveBeenCalledTimes(1);
  expect(mockAccrue).toHaveBeenCalledWith('p1', 130000, 5, costUsd(130000, 5, 'anthropic'));
});

test('a non-refusal failure is NOT metered (nothing was reported as billed)', async () => {
  mockEvaluate.mockImplementationOnce(async () => { throw Object.assign(new Error('RIMPL /evaluate error: 502'), { status: 502 }); });
  await triggerEvaluation('ple1', [{ role: 'physician', content: 'x' }], 'doc1').catch(() => {});
  expect(mockAccrue).not.toHaveBeenCalled();
});
