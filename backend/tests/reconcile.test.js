// The reconcile sweep (soak finding F1): a cle_pass session with no ai_evaluations row must be
// re-evaluated; already-evaluated ones are skipped; one failed re-evaluation must not abort the sweep.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockPles;  // rows returned for the status='cle_pass' sweep query
let mockEvals; // ple_id -> existing ai_evaluations row (absence = stranded)
let mockMsgs;  // ple_id -> message rows

// Table-aware chainable mock: ples ends in .limit(), ai_evaluations in .maybeSingle(),
// messages in .order(); .eq('ple_id', …) captures which session is being looked up.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let pleId;
      const c = {
        select: () => c,
        eq: (col, val) => { if (col === 'ple_id') pleId = val; return c; },
        limit: () => Promise.resolve({ data: mockPles, error: null }),
        maybeSingle: () => Promise.resolve({ data: mockEvals[pleId] ?? null, error: null }),
        order: () => Promise.resolve({ data: (table === 'messages' ? mockMsgs[pleId] : null) ?? [], error: null }),
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
  expect(result).toEqual({ stuck: 1, recovered: 1, failed: 0 });
});

test('an already-evaluated session is skipped (idempotent — trigger NOT called)', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }];
  mockEvals = { ple1: { id: 'eval1' } };
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(result).toEqual({ stuck: 1, recovered: 0, failed: 0 });
});

test('a triggerEvaluation throw counts as failed and the sweep continues to the next session', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1' }, { id: 'ple2', physician_id: 'doc2' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'x' }], ple2: [{ role: 'physician', content: 'y' }] };
  triggerEvaluation.mockImplementation((pleId) =>
    pleId === 'ple1' ? Promise.reject(new Error('RIMPL down')) : Promise.resolve());
  const result = await reconcileEvaluations();
  expect(triggerEvaluation).toHaveBeenCalledTimes(2); // ple2 still attempted after ple1 failed
  expect(result).toEqual({ stuck: 2, recovered: 1, failed: 1 });
});
