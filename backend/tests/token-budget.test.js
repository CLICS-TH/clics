// Token-denominated budgets (lib/usage.js). The on-prem model is priced at $0, so the $-cap never
// throttles it; the token ceiling is a second comparison on the counters that always existed.
let mockSettings, mockRpcArgs;
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let key;
      const c = {
        select: () => c,
        eq: (col, val) => { if (col === 'key') key = val; return c; },
        single: () => Promise.resolve({ data: mockSettings[key] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: mockSettings[key] ?? null, error: null }),
      };
      return c;
    },
    rpc: (fn, args) => { mockRpcArgs.push([fn, args]); return Promise.resolve({ data: true, error: null }); },
  },
}));
const usage = require('../src/lib/usage');

beforeEach(() => { mockSettings = {}; mockRpcArgs = []; usage._resetCaches(); });

test('no token setting (pre-migration) → no token cap: only the $ ceiling decides', async () => {
  mockSettings = { standard_usage_limit_usd: { value: 0.5 } };
  expect(await usage.standardTokenLimit('physician')).toBeNull();
  const b = await usage.budgetState({ usage_cost_usd: 0.1, usage_input_tokens: 9_000_000, usage_output_tokens: 1 });
  expect(b).toMatchObject({ over: false, reason: null, tokenLimit: null });
});

test('tokens over the org ceiling → over with reason tokens, even with $ untouched', async () => {
  mockSettings = { standard_usage_limit_usd: { value: 0.5 }, standard_usage_limit_tokens: { value: 300000 } };
  const b = await usage.budgetState({ usage_cost_usd: 0, usage_input_tokens: 200000, usage_output_tokens: 100000 });
  expect(b).toMatchObject({ over: true, reason: 'tokens', tokenLimit: 300000, tokens: 300000 });
});

test('$ over wins the reason when both are over; under both → not over', async () => {
  mockSettings = { standard_usage_limit_usd: { value: 0.5 }, standard_usage_limit_tokens: { value: 300000 } };
  expect((await usage.budgetState({ usage_cost_usd: 0.5, usage_input_tokens: 400000, usage_output_tokens: 0 })).reason).toBe('cost');
  expect((await usage.budgetState({ usage_cost_usd: 0.1, usage_input_tokens: 1000, usage_output_tokens: 1000 })).over).toBe(false);
});

test('a per-user token override wins over the org ceiling; 0 means no token cap for that user', async () => {
  mockSettings = { standard_usage_limit_tokens: { value: 300000 } };
  expect(await usage.effectiveTokenLimit({ usage_limit_tokens: 50000 })).toBe(50000);
  expect(await usage.effectiveTokenLimit({ usage_limit_tokens: 0 })).toBeNull();
  expect(await usage.effectiveTokenLimit({ usage_limit_tokens: null })).toBe(300000);
});

test('the auditor pool reads ITS OWN counters and ceiling', async () => {
  mockSettings = { auditor_standard_usage_limit_usd: { value: 0.5 }, auditor_standard_usage_limit_tokens: { value: 1000 } };
  const b = await usage.budgetState({ usage_input_tokens: 5000, auditor_usage_input_tokens: 999, auditor_usage_output_tokens: 1, auditor_usage_cost_usd: 0 }, 'auditor');
  expect(b).toMatchObject({ over: true, reason: 'tokens', tokens: 1000, tokenLimit: 1000 });
});

test('reserveUsage passes p_token_limit only when a ceiling applies (pre-migration RPC stays 3-arg)', async () => {
  await usage.reserveUsage('u1', 0.5, 0.02, 'physician', 300000);
  expect(mockRpcArgs.at(-1)).toEqual(['reserve_usage', { p_id: 'u1', p_estimate: 0.02, p_limit: 0.5, p_token_limit: 300000 }]);
  await usage.reserveUsage('u1', 0.5, 0.02, 'auditor', null);
  expect(mockRpcArgs.at(-1)).toEqual(['reserve_auditor_usage', { p_id: 'u1', p_estimate: 0.02, p_limit: 0.5 }]);
});
