// The evaluation drain (services/eval-drain.js) is the only thing that starts a PIS-7 evaluation.
//   * it claims via the SQL RPC with the council scope, oldest first, up to the free concurrency;
//   * success clears the claim; a DETERMINISTIC failure routes to manual QA (guarded on ple_pass);
//   * a TRANSIENT failure defers with backoff (honouring the server's Retry-After), never drops;
//   * exhausted attempts route to manual QA with an audit event;
//   * it never exceeds the concurrency, and never scores an empty transcript.
process.env.EVAL_MAX_ATTEMPTS = '3';
let mockRows, mockMsgs, mockMsgsError, mockRefs, mockClaims, mockWrites, mockRpcCalls, mockSettings, mockCouncils, mockSpend;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let id, key, op = 'select', payload; const eqs = [];
      const c = {
        select: () => c,
        update: (p) => { op = 'update'; payload = p; return c; },
        eq: (col, val) => { eqs.push([col, val]); if (col === 'id' || col === 'ple_id') id = val; if (col === 'key') key = val; return c; },
        in: () => c, order: () => c, limit: () => c, lt: () => c, is: () => c,
        maybeSingle: () => {
          if (table === 'ples') return Promise.resolve({ data: mockRows[id] ?? null, error: null });
          if (table === 'ple_patient_refs') return Promise.resolve({ data: mockRefs[id] ? { patient_ref: mockRefs[id] } : null, error: null });
          if (table === 'app_settings') return Promise.resolve({ data: mockSettings[key] ?? null, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve) => {
          if (op === 'update') mockWrites.push({ table, id, payload, eqs });
          let data = null;
          if (op === 'select' && table === 'messages') {
            if (mockMsgsError) return Promise.resolve({ data: null, error: { message: mockMsgsError } }).then(resolve);
            data = mockMsgs[id] ?? [];
          }
          if (op === 'select' && table === 'councils') data = mockCouncils;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return c;
    },
    rpc: (fn, args) => {
      mockRpcCalls.push([fn, args]);
      // total_usage_sum is the org-wide spend the budget pool reads. Answered distinctly, because
      // returning the claim list for it would make Number([...]) NaN and pause the drain for a
      // reason the test never asked for.
      if (fn === 'total_usage_sum') return Promise.resolve({ data: mockSpend, error: mockSpend === undefined ? { message: 'rpc missing' } : null });
      return Promise.resolve({ data: mockClaims.map((id) => ({ id })), error: null });
    },
  },
}));
jest.mock('../src/services/reflection', () => ({ withReflection: async (_id, t) => t }));
jest.mock('../src/lib/audit', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/ple-evaluation', () => ({ triggerEvaluation: jest.fn() }));
jest.mock('../src/services/rimpl-client', () => ({
  isDeterministicRimplError: (e) => e && [400, 401, 403, 413, 422, 502].includes(e.status),
}));

const { triggerEvaluation } = require('../src/services/ple-evaluation');
const { logEvent } = require('../src/lib/audit');
const { invalidateScope } = require('../src/lib/eval-scope');
const drain = require('../src/services/eval-drain');

const MSGS = [{ role: 'physician', content: 'chest pain' }, { role: 'assistant', content: 'tell me more' }];
// Evaluations run off the tick; wait until nothing is in flight.
async function settle() {
  for (let i = 0; i < 50 && (drain._state.inFlight > 0 || drain._state.ticking); i++) await new Promise((r) => setImmediate(r));
}
const updates = (table) => mockWrites.filter((w) => w.table === table);

beforeEach(() => {
  mockRows = {}; mockMsgs = {}; mockMsgsError = null; mockRefs = {}; mockClaims = []; mockWrites = []; mockRpcCalls = [];
  mockSettings = {}; mockCouncils = []; mockSpend = 0;
  invalidateScope();
  Object.assign(drain._state, { running: false, inFlight: 0, ticking: false, kicked: false, claimed: 0, evaluated: 0, deferred: 0, flagged: 0, lastError: null, pool: null, poolWasExhausted: false });
  triggerEvaluation.mockReset().mockResolvedValue(undefined);
  logEvent.mockClear();
});

test('claims through the RPC with the scope, evaluates with attempts:1 and the patient_ref, then clears the claim', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1, council_id: 'c1' } };
  mockMsgs = { p1: MSGS }; mockRefs = { p1: 'นายสมชาย ใจดี' }; mockClaims = ['p1'];
  await drain.tick(); await settle();
  expect(mockRpcCalls[0][0]).toBe('claim_ple_evaluations');
  expect(mockRpcCalls[0][1]).toMatchObject({ p_limit: 1, p_exclude_councils: null, p_include_councils: null });
  expect(triggerEvaluation).toHaveBeenCalledWith('p1', MSGS, 'doc1', 'นายสมชาย ใจดี', { attempts: 1 });
  const clear = updates('ples').find((w) => w.id === 'p1' && w.payload.eval_claimed_at === null && w.payload.eval_last_error === null);
  expect(clear).toBeTruthy();
  expect(drain.status().counters).toMatchObject({ claimed: 1, evaluated: 1, deferred: 0, flagged: 0 });
});

test('a DETERMINISTIC failure (413/502) routes to manual QA — guarded so an evaluated row is never overwritten', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1 } };
  mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  triggerEvaluation.mockImplementation(() => { const e = new Error('too large'); e.status = 413; e.code = 'transcript_too_large'; return Promise.reject(e); });
  await drain.tick(); await settle();
  const flag = updates('ples').find((w) => w.payload.status === 'ple_flag_t2');
  expect(flag).toBeTruthy();
  expect(flag.eqs).toEqual(expect.arrayContaining([['id', 'p1'], ['status', 'ple_pass']]));
  expect(flag.payload.eval_last_error).toMatch(/deterministic:413:transcript_too_large/);
  expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ple.eval_deterministic_failure', targetId: 'p1' }));
  expect(drain.status().counters.flagged).toBe(1);
});

test('a TRANSIENT failure defers with the server\'s Retry-After, keeps the row ple_pass, and frees the claim', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 2 } };
  mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  triggerEvaluation.mockImplementation(() => { const e = new Error('queue full'); e.status = 503; e.code = 'queue_full'; e.retryAfterMs = 30_000; return Promise.reject(e); });
  const t0 = Date.now();
  await drain.tick(); await settle();
  const deferred = updates('ples').find((w) => w.payload.eval_next_at);
  expect(deferred).toBeTruthy();
  expect(deferred.payload.status).toBeUndefined();
  expect(deferred.payload.eval_claimed_at).toBeNull();
  expect(deferred.payload.eval_last_error).toBe('503:queue_full');
  const next = Date.parse(deferred.payload.eval_next_at) - t0;
  expect(next).toBeGreaterThanOrEqual(30_000);
  expect(next).toBeLessThan(30_000 + 6_000);   // + jitter ≤ 5s
  expect(updates('ples').some((w) => w.payload.status === 'ple_flag_t2')).toBe(false);
  expect(drain.status().counters.deferred).toBe(1);
});

test('exhausted attempts route to manual QA with an audit event', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 3 } }; // EVAL_MAX_ATTEMPTS=3
  mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  triggerEvaluation.mockRejectedValue(Object.assign(new Error('timeout'), { status: undefined }));
  await drain.tick(); await settle();
  expect(updates('ples').some((w) => w.payload.status === 'ple_flag_t2' && /exhausted:3/.test(w.payload.eval_last_error))).toBe(true);
  expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ple.eval_exhausted' }));
});

test('an EMPTY transcript is never evaluated and goes to manual QA — it can never grow, so deferring it would loop forever', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1 } };
  mockMsgs = { p1: [] }; mockClaims = ['p1'];
  await drain.tick(); await settle();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  const flag = updates('ples').find((w) => w.payload.status === 'ple_flag_t2');
  expect(flag).toBeDefined();
  expect(flag.payload.eval_last_error).toMatch(/transcript_empty/);
  expect(updates('ples').some((w) => w.payload.eval_next_at)).toBe(false);
  expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ple.eval_deterministic_failure' }));
});

test('a FAILED messages read is transient: deferred with backoff, never evaluated, never flagged', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1 } };
  mockMsgsError = 'connection reset'; mockClaims = ['p1'];
  await drain.tick(); await settle();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(updates('ples').some((w) => w.payload.eval_next_at)).toBe(true);
  expect(updates('ples').some((w) => w.payload.status === 'ple_flag_t2')).toBe(false);
});

test('never claims more than the free concurrency, and a tick while saturated claims nothing', async () => {
  mockSettings = { eval_drain_concurrency: { value: 1 } };
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1 } };
  mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  let release;
  triggerEvaluation.mockImplementation(() => new Promise((r) => { release = r; }));
  await drain.tick();                       // claims p1 (p_limit 1) and starts it
  // runOne loads the transcript before it calls the evaluator — wait for the call to be in flight.
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
  expect(release).toEqual(expect.any(Function));
  expect(mockRpcCalls).toHaveLength(1);
  expect(mockRpcCalls[0][1].p_limit).toBe(1);
  await drain.tick();                       // saturated: free = 0 → no RPC
  expect(mockRpcCalls).toHaveLength(1);
  release(); await settle();
  expect(drain._state.inFlight).toBe(0);
});

test('a row that is no longer ple_pass when loaded is left alone (raced with another writer)', async () => {
  mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'evaluated', eval_attempts: 1 } };
  mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  await drain.tick(); await settle();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(updates('ples')).toHaveLength(0);
});

test('backoff doubles per attempt and is capped at 15 minutes', () => {
  expect(drain.backoffMs(1)).toBeGreaterThanOrEqual(30_000);
  expect(drain.backoffMs(1)).toBeLessThan(36_000);
  expect(drain.backoffMs(2)).toBeGreaterThanOrEqual(60_000);
  expect(drain.backoffMs(10)).toBeLessThan(15 * 60_000 + 6_000);
  expect(drain.backoffMs(10)).toBeGreaterThanOrEqual(15 * 60_000);
});

// app_settings.api_budget_pool_usd was rendered on two admin screens and consulted by nothing, while
// evaluation — the largest single spend in the system — had no ceiling at all. An operator who set
// it to 12 believed spend stopped at $12; the only real ceiling was the Anthropic account balance.
describe('the org-wide budget pool actually stops evaluation', () => {
  const ready = () => {
    mockRows = { p1: { id: 'p1', physician_id: 'doc1', status: 'ple_pass', eval_attempts: 1 } };
    mockMsgs = { p1: MSGS }; mockClaims = ['p1'];
  };

  test('unset (0) means no cap, so an untouched deployment behaves exactly as before', async () => {
    ready();                       // mockSettings has no api_budget_pool_usd -> default 0
    await drain.tick(); await settle();
    expect(triggerEvaluation).toHaveBeenCalled();
    expect(drain.status().pool).toMatchObject({ uncapped: true });
    // With no cap the spend query is never even run.
    expect(mockRpcCalls.map(c => c[0])).not.toContain('total_usage_sum');
  });

  test('under the cap: work proceeds and the reading is reported', async () => {
    ready(); mockSettings.api_budget_pool_usd = { value: 12 }; mockSpend = 0.91;
    await drain.tick(); await settle();
    expect(triggerEvaluation).toHaveBeenCalled();
    expect(drain.status().pool).toMatchObject({ cap: 12, spent: 0.91, exhausted: false });
  });

  test('at the cap: NOTHING is claimed — gated before the claim so no eval_attempt is burnt', async () => {
    ready(); mockSettings.api_budget_pool_usd = { value: 12 }; mockSpend = 12;
    await drain.tick(); await settle();
    expect(triggerEvaluation).not.toHaveBeenCalled();
    // The claim RPC must not run at all. Claiming and then deferring would march every queued PLE to
    // MAX_ATTEMPTS and flag it for manual QA, when the only thing wrong was an unraised cap.
    expect(mockRpcCalls.map(c => c[0])).not.toContain('claim_ple_evaluations');
    expect(drain.status().counters.claimed).toBe(0);
    // The queue is untouched: no defer, no flag, no write of any kind.
    expect(mockWrites).toEqual([]);
    expect(drain.status().pool).toMatchObject({ cap: 12, exhausted: true });
  });

  test('an unreadable spend is treated as exhausted, not as plenty left', async () => {
    ready(); mockSettings.api_budget_pool_usd = { value: 12 }; mockSpend = undefined; // rpc errors
    await drain.tick(); await settle();
    // The fallback column read returns null through this mock, so spend is unknown. Spending real
    // money on the strength of a failed query is the wrong way to fail.
    expect(triggerEvaluation).not.toHaveBeenCalled();
    expect(drain.status().pool.exhausted).toBe(true);
  });

  test('raising the cap resumes claiming without an operator touching the queue', async () => {
    ready(); mockSettings.api_budget_pool_usd = { value: 12 }; mockSpend = 12;
    await drain.tick(); await settle();
    expect(triggerEvaluation).not.toHaveBeenCalled();

    mockSettings.api_budget_pool_usd = { value: 50 };
    mockRpcCalls = []; mockClaims = ['p1'];
    await drain.tick(); await settle();
    expect(triggerEvaluation).toHaveBeenCalledWith('p1', MSGS, 'doc1', null, { attempts: 1 });
  });
});
