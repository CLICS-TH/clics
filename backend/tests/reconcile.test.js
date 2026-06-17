// The reconcile sweep recovers sessions stranded short of a terminal status:
//   * cle_pass with NO ai_evaluations row → re-evaluate (recovered);
//   * cle_pass WITH an ai row → PARTIAL persist, repair in place, no paid re-eval (repaired);
//   * 'ended' (tier-1 passed, tier-2 never finished) → finish screening via finalizeScreening (recovered);
//   * a DETERMINISTIC eval failure (502 bad output) → route to manual QA (flagged), don't loop forever;
//   * a transient failure / empty transcript → counted failed, sweep continues.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockCles;   // rows returned for the sweep query
let mockEvals;  // cle_id -> existing ai_evaluations row (absence = stranded; presence = partial persist)
let mockMsgs;   // cle_id -> message rows
let mockWrites; // captured insert/update ops for assertions

// Table-aware thenable mock: cles sweep ends in .in().lt().order().limit(); ai_evaluations in
// .maybeSingle(); messages in .order(); inserts/updates are captured.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let cleId, op = 'select', payload;
      const c = {
        select: () => c,
        update: (p) => { op = 'update'; payload = p; return c; },
        insert: (p) => { op = 'insert'; payload = p; mockWrites.push({ table, op, payload }); return Promise.resolve({ error: null }); },
        eq: (col, val) => { if (col === 'cle_id') cleId = val; return c; },
        in: () => c,
        lt: () => c,
        order: () => c,
        limit: () => Promise.resolve({ data: mockCles, error: null }),
        maybeSingle: () => Promise.resolve({ data: mockEvals[cleId] ?? null, error: null }),
        then: (resolve) => {
          if (op === 'update') mockWrites.push({ table, op, payload });
          const data = (op === 'select' && table === 'messages') ? (mockMsgs[cleId] ?? []) : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return c;
    },
  },
}));

jest.mock('../src/services/cle-evaluation', () => ({ triggerEvaluation: jest.fn() }));
jest.mock('../src/services/cle-finalize', () => ({ finalizeScreening: jest.fn() }));
jest.mock('../src/services/rimpl-client', () => ({
  isDeterministicRimplError: (e) => e && [400, 401, 403, 422, 502].includes(e.status),
}));

const { triggerEvaluation } = require('../src/services/cle-evaluation');
const { finalizeScreening } = require('../src/services/cle-finalize');
const { reconcileEvaluations } = require('../src/services/reconcile');

beforeEach(() => {
  mockCles = [];
  mockEvals = {};
  mockMsgs = {};
  mockWrites = [];
  triggerEvaluation.mockReset().mockResolvedValue(undefined);
  finalizeScreening.mockReset().mockResolvedValue({ status: 'cle_pass', criteria: {} });
});

test('a stranded cle_pass session (no eval row) gets re-evaluated and counts as recovered', async () => {
  mockCles = [{ id: 'ple1', physician_id: 'doc1', status: 'cle_pass' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'chest pain workup' }, { role: 'assistant', content: 'tell me more' }] };
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).toHaveBeenCalledTimes(1);
  expect(triggerEvaluation).toHaveBeenCalledWith(
    'ple1',
    [{ role: 'physician', content: 'chest pain workup' }, { role: 'assistant', content: 'tell me more' }],
    'doc1'
  );
  expect(result).toEqual({ stuck: 1, recovered: 1, repaired: 0, flagged: 0, failed: 0 });
});

test("a stranded 'ended' session finishes tier-2 via finalizeScreening (recovered)", async () => {
  mockCles = [{ id: 'cleE', physician_id: 'doc1', status: 'ended', c1_pass: true, c2_pass: true, c3_pass: true }];
  mockMsgs = { cleE: [{ role: 'physician', content: 'x' }, { role: 'assistant', content: 'y' }] };
  const result = await reconcileEvaluations();
  expect(finalizeScreening).toHaveBeenCalledTimes(1);
  expect(finalizeScreening).toHaveBeenCalledWith(expect.objectContaining({
    cleId: 'cleE', physicianId: 'doc1', tier1: { c1: true, c2: true, c3: true },
  }));
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(result).toEqual({ stuck: 1, recovered: 1, repaired: 0, flagged: 0, failed: 0 });
});

test('a PARTIAL persist (ai row exists, still cle_pass) is REPAIRED with no paid re-eval', async () => {
  mockCles = [{ id: 'ple1', physician_id: 'doc1', status: 'cle_pass' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'x' }] };
  mockEvals = { ple1: { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 60 } };
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).not.toHaveBeenCalled();           // never pays for a re-evaluation
  expect(mockWrites.some(w => w.table === 'lpdp_snapshots' && w.op === 'insert')).toBe(true); // snapshot backfilled
  expect(mockWrites.some(w => w.table === 'cles' && w.op === 'update' && w.payload.status === 'evaluated')).toBe(true);
  expect(result).toEqual({ stuck: 1, recovered: 0, repaired: 1, flagged: 0, failed: 0 });
});

test('a transient triggerEvaluation throw counts as failed and the sweep continues', async () => {
  mockCles = [{ id: 'ple1', physician_id: 'doc1', status: 'cle_pass' }, { id: 'ple2', physician_id: 'doc2', status: 'cle_pass' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'x' }], ple2: [{ role: 'physician', content: 'y' }] };
  triggerEvaluation.mockImplementation((cleId) =>
    cleId === 'ple1' ? Promise.reject(new Error('RIMPL down')) : Promise.resolve());
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).toHaveBeenCalledTimes(2); // ple2 still attempted after ple1 failed
  expect(result).toEqual({ stuck: 2, recovered: 1, repaired: 0, flagged: 0, failed: 1 });
});

test('a DETERMINISTIC eval failure (502) routes the session to manual QA (flagged), not an infinite retry', async () => {
  mockCles = [{ id: 'cleD', physician_id: 'doc1', status: 'cle_pass' }];
  mockMsgs = { cleD: [{ role: 'physician', content: 'x' }] };
  triggerEvaluation.mockImplementation(() => { const e = new Error('bad output'); e.status = 502; return Promise.reject(e); });
  const result = await reconcileEvaluations();
  expect(mockWrites.some(w => w.table === 'cles' && w.op === 'update' && w.payload.status === 'cle_flag_t2')).toBe(true);
  expect(result).toEqual({ stuck: 1, recovered: 0, repaired: 0, flagged: 1, failed: 0 });
});

test('an empty/failed transcript is skipped (not scored) and counted as failed', async () => {
  mockCles = [{ id: 'ple1', physician_id: 'doc1', status: 'cle_pass' }];
  mockMsgs = { ple1: [] }; // no messages — must NOT evaluate an empty transcript into a bogus score
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(finalizeScreening).not.toHaveBeenCalled();
  expect(result).toEqual({ stuck: 1, recovered: 0, repaired: 0, flagged: 0, failed: 1 });
});
