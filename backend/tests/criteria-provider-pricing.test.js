// REGRESSION (confirmed HIGH by three independent review lenses, 2026-08-24).
//
// finalizeScreening() meters the tier-2 C4–C6 criteria call. Every other AI spend path was converted
// to provider-aware pricing (cles.js chat, auditor.js discuss, cle-evaluation.js PIS-7) — this one
// was missed, so it fell through to usage.js's 2-arg costUsd() and billed at Anthropic rates no
// matter who served the call.
//
// Why it bites hard: the classifier prompt carries the FULL transcript. For the 130k-token CLE-052
// case, an all-local deployment would charge ~$0.39 of a physician's $0.50 cap for a call whose
// marginal cost is $0 — locking them out after a couple of free CLEs and invoicing the council for
// compute it already owns.
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) },
}));

let mockCrit;
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluateCriteria: jest.fn(async () => mockCrit),
  isDeterministicRimplError: () => false,
}));
const mockAccrue = jest.fn(async () => {});
jest.mock('../src/lib/usage', () => ({ accrueUsage: (...a) => mockAccrue(...a) }));
jest.mock('../src/services/cle-evaluation', () => ({ triggerEvaluation: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/lib/pii-map', () => ({ persistPiiMap: jest.fn(async () => {}) }));

const { finalizeScreening } = require('../src/services/cle-finalize');

const run = () => finalizeScreening({
  cleId: 'c1', physicianId: 'p1', transcript: [{ role: 'physician', content: 'x' }],
  tier1: { c1: true, c2: true, c3: true }, patient_ref: null,
});
// The 4th accrueUsage arg is the costOverride — null/undefined means "fall back to anthropic rates".
const costArg = () => mockAccrue.mock.calls[0][3];

beforeEach(() => { mockAccrue.mockClear(); });

test('a LOCAL criteria call is metered at $0, not at Anthropic rates', async () => {
  mockCrit = { c4: true, c5: true, c6: true, input_tokens: 130000, output_tokens: 50, provider: 'local', pii_map: [] };
  await run();
  expect(mockAccrue).toHaveBeenCalledTimes(1);
  // Token counts are still recorded — only the DOLLARS are zero.
  expect(mockAccrue.mock.calls[0].slice(0, 3)).toEqual(['p1', 130000, 50]);
  expect(costArg()).toBe(0);
});

test('an ANTHROPIC criteria call still bills the full real cost (no behaviour change on the paid path)', async () => {
  mockCrit = { c4: true, c5: true, c6: true, input_tokens: 130000, output_tokens: 50, provider: 'anthropic', pii_map: [] };
  await run();
  // 130000/1e6*3 + 50/1e6*15
  expect(costArg()).toBeCloseTo(0.39075, 6);
});

test('a criteria response with NO provider is billed as anthropic (fail toward over-billing)', async () => {
  mockCrit = { c4: true, c5: true, c6: true, input_tokens: 130000, output_tokens: 50, pii_map: [] };
  await run();
  expect(costArg()).toBeCloseTo(0.39075, 6);
});

test('the c4-c6 FAIL path meters identically — a flagged CLE is not billed differently', async () => {
  mockCrit = { c4: false, c5: true, c6: true, input_tokens: 1000, output_tokens: 10, provider: 'local', pii_map: [] };
  const out = await run();
  expect(out.status).toBe('cle_flag_t2');
  expect(costArg()).toBe(0);
});
