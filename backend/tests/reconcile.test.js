// The reconcile sweep (soak finding F1): a cle_pass session with NO ai_evaluations row must be
// re-evaluated; one WITH an ai row is a PARTIAL persist (score landed, status/snapshot never did) and
// must be REPAIRED in place (no paid re-eval); one failed re-evaluation must not abort the sweep.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockPles;   // rows returned for the status='cle_pass' sweep query
let mockEvals;  // ple_id -> existing ai_evaluations row (absence = stranded; presence = partial persist)
let mockMsgs;   // ple_id -> message rows
let mockWrites; // captured insert/update ops for assertions

// Table-aware thenable mock: ples sweep ends in .order().limit(); ai_evaluations in .maybeSingle();
// messages in .order(); lpdp_snapshots .insert() and the ples status .update().eq() are awaited via .then.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let pleId, op = 'select', payload;
      const c = {
        select: () => c,
        update: (p) => { op = 'update'; payload = p; return c; },
        insert: (p) => { op = 'insert'; payload = p; mockWrites.push({ table, op, payload }); return Promise.resolve({ error: null }); },
        eq: (col, val) => { if (col === 'ple_id') pleId = val; return c; },
        order: () => c,
        limit: () => Promise.resolve({ data: mockPles, error: null }),
        maybeSingle: () => Promise.resolve({ data: mockEvals[pleId] ?? null, error: null }),
        then: (resolve) => {
          if (op === 'update') mockWrites.push({ table, op, payload });
          const data = (op === 'select' && table === 'messages') ? (mockMsgs[pleId] ?? []) : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return c;
    },
  },
}));

jest.mock('../src/services/ple-evaluation', () => ({ triggerEvaluation: jest.fn() }));

const { triggerEvaluation } = require('../src/services/ple-evaluation');
const { reconcileEvaluations } = require('../src/services/reconcile');

beforeEach(() => {
  mockPles = [];
  mockEvals = {};
  mockMsgs = {};
  mockWrites = [];
  triggerEvaluation.mockReset().mockResolvedValue(undefined);
});

test('a stranded cle_pass session (no eval row) gets re-evaluated and counts as recovered', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'chest pain workup' }, { role: 'assistant', content: 'tell me more' }] };
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).toHaveBeenCalledTimes(1);
  expect(triggerEvaluation).toHaveBeenCalledWith(
    'ple1',
    [{ role: 'physician', content: 'chest pain workup' }, { role: 'assistant', content: 'tell me more' }],
    'doc1'
  );
  expect(result).toEqual({ stuck: 1, recovered: 1, repaired: 0, failed: 0 });
});

test('a PARTIAL persist (ai row exists, still cle_pass) is REPAIRED with no paid re-eval', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }];
  mockEvals = { ple1: { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 60 } };
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).not.toHaveBeenCalled();           // never pays for a re-evaluation
  expect(mockWrites.some(w => w.table === 'lpdp_snapshots' && w.op === 'insert')).toBe(true); // snapshot backfilled
  expect(mockWrites.some(w => w.table === 'ples' && w.op === 'update' && w.payload.status === 'evaluated')).toBe(true);
  expect(result).toEqual({ stuck: 1, recovered: 0, repaired: 1, failed: 0 });
});

test('a triggerEvaluation throw counts as failed and the sweep continues to the next session', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }, { id: 'ple2', physician_id: 'doc2' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'x' }], ple2: [{ role: 'physician', content: 'y' }] };
  triggerEvaluation.mockImplementation((pleId) =>
    pleId === 'ple1' ? Promise.reject(new Error('RIMPL down')) : Promise.resolve());
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).toHaveBeenCalledTimes(2); // ple2 still attempted after ple1 failed
  expect(result).toEqual({ stuck: 2, recovered: 1, repaired: 0, failed: 1 });
});

test('an empty/failed transcript is skipped (not scored) and counted as failed', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }];
  mockMsgs = { ple1: [] }; // no messages — must NOT evaluate an empty transcript into a bogus score
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(result).toEqual({ stuck: 1, recovered: 0, repaired: 0, failed: 1 });
});
