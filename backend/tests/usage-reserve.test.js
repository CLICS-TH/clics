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

test('reserveUsage returns true when the meter is under budget', async () => {
  mockReserve = { data: true, error: null };
  await expect(reserveUsage('u1', 0.5)).resolves.toBe(true);
});

test('reserveUsage returns false when over budget (turn blocked)', async () => {
  mockReserve = { data: false, error: null };
  await expect(reserveUsage('u1', 0.5)).resolves.toBe(false);
});

test('reserveUsage fails OPEN on an rpc error — never blocks a turn on a metering fault', async () => {
  mockReserve = { data: null, error: { message: 'reserve_usage not found (pre-migration)' } };
  await expect(reserveUsage('u1', 0.5)).resolves.toBe(true);
});

test('settleUsage reconciles the reservation to the real cost (delta = actual − estimate)', async () => {
  await settleUsage('u1', RESERVE_ESTIMATE_USD, 1000, 500);
  expect(mockIncrementCalls).toHaveLength(1);
  expect(mockIncrementCalls[0].p_cost).toBeCloseTo(costUsd(1000, 500) - RESERVE_ESTIMATE_USD, 9);
  expect(mockIncrementCalls[0].p_in).toBe(1000);
  expect(mockIncrementCalls[0].p_out).toBe(500);
});

test('refundUsage releases the reservation (negative cost, no tokens)', async () => {
  await refundUsage('u1', RESERVE_ESTIMATE_USD);
  expect(mockIncrementCalls).toHaveLength(1);
  expect(mockIncrementCalls[0].p_cost).toBeCloseTo(-RESERVE_ESTIMATE_USD, 9);
  expect(mockIncrementCalls[0].p_in).toBe(0);
  expect(mockIncrementCalls[0].p_out).toBe(0);
});
