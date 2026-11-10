// #425 gate F1: rimpl answers a reply with no answer text as 503 empty_reply. Through the REAL
// rimpl-client and eval-drain, a persistently empty evaluator reply must be bounded (manual QA after
// EVAL_EMPTY_REPLY_MAX_ATTEMPTS), back off on the drain's own schedule (no 5 s storm), and meter every
// attempt's burned tokens so the budget pool sees them. Only fetch and Supabase are stubbed.
process.env.EVAL_MAX_ATTEMPTS = '20';
let mockRow, mockWrites, mockRpcCalls;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let op = 'select', payload; const eqs = [];
      const c = {
        select: () => c,
        update: (p) => { op = 'update'; payload = p; return c; },
        eq: (col, val) => { eqs.push([col, val]); return c; },
        in: () => c, order: () => c, limit: () => c, lt: () => c, is: () => c,
        maybeSingle: () => Promise.resolve({ data: table === 'ples' ? { ...mockRow } : null, error: null }),
        then: (resolve) => {
          if (op === 'update' && table === 'ples' && eqs.every(([k, v]) => mockRow[k] === v)) {
            mockWrites.push(payload);
            Object.assign(mockRow, payload);
          }
          const data = op === 'select' && table === 'messages' ? [{ role: 'physician', content: 'chest pain' }] : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return c;
    },
    rpc: (fn, args) => {
      mockRpcCalls.push([fn, args]);
      if (fn === 'total_usage_sum') return Promise.resolve({ data: 0, error: null });
      if (fn === 'claim_ple_evaluations') {
        if (mockRow.status !== 'ple_pass') return Promise.resolve({ data: [], error: null });
        mockRow.eval_attempts += 1;
        return Promise.resolve({ data: [{ id: mockRow.id }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
jest.mock('../src/services/reflection', () => ({ withReflection: async (_id, t) => t }));
jest.mock('../src/lib/audit', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/ple-evaluation', () => {
  const { rimplEvaluate } = jest.requireActual('../src/services/rimpl-client');
  return { triggerEvaluation: jest.fn((pleId, transcript) => rimplEvaluate({ ple_id: pleId, transcript })) };
});

const drain = require('../src/services/eval-drain');

const EMPTY_REPLY = { error: 'Evaluation service temporarily unavailable.', code: 'empty_reply', input_tokens: 9000, output_tokens: 4096, provider: 'local' };
let realFetch, fetchCalls;

async function settle() {
  for (let i = 0; i < 50 && (drain._state.inFlight > 0 || drain._state.ticking); i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  mockRow = { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 0, council_id: null, chief_complaint: 'x' };
  mockWrites = []; mockRpcCalls = []; fetchCalls = 0;
  Object.assign(drain._state, { running: false, inFlight: 0, ticking: false, kicked: false, claimed: 0, evaluated: 0, deferred: 0, flagged: 0, lastError: null, pool: null, poolWasExhausted: false });
  realFetch = global.fetch;
  global.fetch = jest.fn(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(EMPTY_REPLY), { status: 503, headers: { 'content-type': 'application/json' } });
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

test('a persistently empty evaluator reply goes to manual QA after 3 metered attempts with exponential backoff', async () => {
  const delays = [];
  for (let tick = 0; tick < 20 && mockRow.status === 'ple_pass'; tick++) {
    const t0 = Date.now();
    await drain.tick();
    await settle();
    if (mockRow.eval_next_at) delays.push(Date.parse(mockRow.eval_next_at) - t0);
    mockRow.eval_next_at = null;
  }

  expect(fetchCalls).toBe(3);
  expect(mockRow.status).toBe('ple_flag_t2');
  expect(mockRow.eval_last_error).toBe('empty_reply:3');

  // The drain's own backoff (30 s, then 60 s, plus jitter), not a 5 s retry hint.
  expect(delays).toHaveLength(2);
  expect(delays[0]).toBeGreaterThanOrEqual(30_000);
  expect(delays[1]).toBeGreaterThanOrEqual(60_000);

  const metered = mockRpcCalls.filter(([fn]) => fn === 'increment_usage');
  expect(metered).toHaveLength(3);
  for (const [, args] of metered) expect(args).toMatchObject({ p_id: 'doc1', p_in: 9000, p_out: 4096 });
});
