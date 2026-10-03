// Unit tests for the usage cost model + effective-limit resolution.
// usage.js reads the standard limit from app_settings; mock supabase so standardLimit() resolves.
let mockSetting = { data: { value: 0.5 }, error: null };
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve(mockSetting) }) }) }),
    rpc: () => Promise.resolve({ error: null }),
  },
  authSupabase: { auth: {} },
}));

const { costUsd, INPUT_PER_M, OUTPUT_PER_M } = require('../src/lib/pricing');
const { effectiveLimit, standardLimit } = require('../src/lib/usage');

beforeEach(() => { mockSetting = { data: { value: 0.5 }, error: null }; });

test('costUsd: default Sonnet 5.5 pricing — 1M in + 1M out = $12', () => {
  expect(INPUT_PER_M).toBe(2);
  expect(OUTPUT_PER_M).toBe(10);
  expect(costUsd(1_000_000, 1_000_000)).toBeCloseTo(12, 6);
});

test('costUsd: zero / missing tokens cost nothing', () => {
  expect(costUsd(0, 0)).toBe(0);
  expect(costUsd()).toBe(0);
});

test('costUsd: input and output priced separately', () => {
  expect(costUsd(1_000_000, 0)).toBeCloseTo(2, 6);
  expect(costUsd(0, 1_000_000)).toBeCloseTo(10, 6);
});

test('effectiveLimit: a per-user override wins over the standard default', async () => {
  await expect(effectiveLimit({ usage_limit_usd: 0.25 })).resolves.toBe(0.25);
  await expect(effectiveLimit({ usage_limit_usd: 0 })).resolves.toBe(0); // 0 is a real (blocking) limit, not "unset"
});

test('effectiveLimit: with no override, falls back to the standard default', async () => {
  await expect(effectiveLimit({})).resolves.toBe(0.5);
  await expect(effectiveLimit({ usage_limit_usd: null })).resolves.toBe(0.5);
});

test('standardLimit: falls back to the constant when app_settings is missing', async () => {
  mockSetting = { data: null, error: null };
  await expect(standardLimit('auditor')).resolves.toBe(0.5); // 'auditor' has no cached value yet
});

test('effectiveLimit: the auditor pool reads its OWN override column, separate from physician', async () => {
  // A dual-role user with both columns set — each pool resolves independently.
  const dual = { usage_limit_usd: 0.25, auditor_usage_limit_usd: 1.5 };
  await expect(effectiveLimit(dual, 'physician')).resolves.toBe(0.25);
  await expect(effectiveLimit(dual, 'auditor')).resolves.toBe(1.5);
  // No auditor override → the auditor standard default (mocked 0.5), NOT the physician override.
  await expect(effectiveLimit({ usage_limit_usd: 0.25 }, 'auditor')).resolves.toBe(0.5);
});
