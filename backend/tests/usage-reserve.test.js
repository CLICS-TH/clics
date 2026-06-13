// Atomic budget reservation (closes the parallel-turn TOCTOU on the $0.50 cap).
let mockReserve = { data: true, error: null };
let mockIncrementCalls = [];
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { value: 0.5 }, error: null }) }) }) }),
    rpc: (name, args) => {
      if (name === 'reserve_usage') return Promise.resolve(mockReserve);
      if (name === 'increment_usage') { mockIncrementCalls.push(args); return Promise.resolve({ error: null }); }
      return Promise.resolve({ error: null });
    },
  },
  authSupabase: { auth: {} },
}));

const { reserveUsage, settleUsage, refundUsage, RESERVE_ESTIMATE_USD } = require('../src/lib/usage');
const { costUsd } = require('../src/lib/pricing');

beforeEach(() => { mockReserve = { data: true, error: null }; mockIncrementCalls = []; });

test('reserveUsage returns {ok,applied}=true/true when under budget (estimate applied)', async () => {
  mockReserve = { data: true, error: null };
  await expect(reserveUsage('u1', 0.5)).resolves.toEqual({ ok: true, applied: true });
});

test('reserveUsage returns ok:false when over budget (turn blocked, nothing applied)', async () => {
  mockReserve = { data: false, error: null };
  await expect(reserveUsage('u1', 0.5)).resolves.toEqual({ ok: false, applied: false });
});

test('reserveUsage fails OPEN on an rpc error but reports applied:false (estimate NOT added)', async () => {
  mockReserve = { data: null, error: { message: 'reserve_usage not found (pre-migration)' } };
  await expect(reserveUsage('u1', 0.5)).resolves.toEqual({ ok: true, applied: false });
});

test('settleUsage(applied=true) reconciles to the real cost (delta = actual − estimate)', async () => {
  await settleUsage('u1', RESERVE_ESTIMATE_USD, 1000, 500, true);
  expect(mockIncrementCalls).toHaveLength(1);
  expect(mockIncrementCalls[0].p_cost).toBeCloseTo(costUsd(1000, 500) - RESERVE_ESTIMATE_USD, 9);
  expect(mockIncrementCalls[0].p_in).toBe(1000);
  expect(mockIncrementCalls[0].p_out).toBe(500);
});

// THE F1 REGRESSION GUARD: when reserve failed open (estimate never applied), settle must add the
// FULL actual — NOT actual − estimate — or the meter runs negative every turn and the cap is defeated.
test('settleUsage(applied=false) adds the FULL actual — meter never runs backwards', async () => {
  await settleUsage('u1', RESERVE_ESTIMATE_USD, 1000, 500, false);
  expect(mockIncrementCalls).toHaveLength(1);
  expect(mockIncrementCalls[0].p_cost).toBeCloseTo(costUsd(1000, 500), 9);
  expect(mockIncrementCalls[0].p_cost).toBeGreaterThan(0);
});

test('refundUsage(applied=true) releases the reservation (negative cost, no tokens)', async () => {
  await refundUsage('u1', RESERVE_ESTIMATE_USD, true);
  expect(mockIncrementCalls).toHaveLength(1);
  expect(mockIncrementCalls[0].p_cost).toBeCloseTo(-RESERVE_ESTIMATE_USD, 9);
  expect(mockIncrementCalls[0].p_in).toBe(0);
  expect(mockIncrementCalls[0].p_out).toBe(0);
});

test('refundUsage(applied=false) is a no-op — nothing was reserved to release', async () => {
  await refundUsage('u1', RESERVE_ESTIMATE_USD, false);
  expect(mockIncrementCalls).toHaveLength(0);
});
