// The reconcile sweep recovers sessions stranded short of a terminal status:
//   * 'ended' (tier-1 passed, tier-2 never finished) → finish screening via finalizeScreening (recovered);
//   * ple_pass WITH an ai row → PARTIAL persist, repair in place, no paid re-eval (repaired);
//   * ple_pass with NO ai row → (re)ENQUEUE for the evaluation drain (requeued) — since the drain,
//     the sweep never scores directly: a second writer would race the drain and could double-score;
//   * an empty/failed transcript → counted failed, sweep continues;
//   * a council the drain must leave alone (lib/eval-scope) → skipped.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockPles;      // rows returned for the sweep query
let mockEvals;     // ple_id -> existing ai_evaluations row (absence = stranded; presence = partial persist)
let mockMsgs;      // ple_id -> message rows
let mockWrites;    // captured insert/update ops for assertions
let mockSettings;  // app_settings key -> { value, value_text }
let mockCouncils;  // rows for the councils lookup

// Table-aware thenable mock: ples sweep ends in .in().lt().order().limit(); ai_evaluations /
// ple_patient_refs / app_settings in .maybeSingle(); messages + councils in a direct await.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let pleId, key, op = 'select', payload;
      const c = {
        select: () => c,
        update: (p) => { op = 'update'; payload = p; return c; },
        insert: (p) => { op = 'insert'; payload = p; mockWrites.push({ table, op, payload }); return Promise.resolve({ error: null }); },
        eq: (col, val) => { if (col === 'ple_id' || col === 'id') pleId = val; if (col === 'key') key = val; return c; },
        in: () => c, lt: () => c, is: () => c, order: () => c,
        limit: () => Promise.resolve({ data: mockPles, error: null }),
        maybeSingle: () => {
          if (table === 'app_settings') return Promise.resolve({ data: mockSettings[key] ?? null, error: null });
          if (table === 'ai_evaluations') return Promise.resolve({ data: mockEvals[pleId] ?? null, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve) => {
          if (op === 'update') mockWrites.push({ table, op, payload, pleId });
          let data = null;
          if (op === 'select' && table === 'messages') data = mockMsgs[pleId] ?? [];
          if (op === 'select' && table === 'councils') data = mockCouncils;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return c;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

jest.mock('../src/services/ple-finalize', () => ({ finalizeScreening: jest.fn(), enqueueEvaluation: jest.fn() }));
jest.mock('../src/services/rimpl-client', () => ({
  isDeterministicRimplError: (e) => e && [400, 401, 403, 413, 422, 502].includes(e.status),
}));

jest.mock('../src/services/eval-drain', () => ({ kick: jest.fn() }));

const { finalizeScreening, enqueueEvaluation } = require('../src/services/ple-finalize');
const { kick } = require('../src/services/eval-drain');
const { reconcileEvaluations } = require('../src/services/reconcile');
const { invalidateScope } = require('../src/lib/eval-scope');

beforeEach(() => {
  mockPles = [];
  mockEvals = {};
  mockMsgs = {};
  mockWrites = [];
  mockSettings = {};
  mockCouncils = [];
  invalidateScope();
  finalizeScreening.mockReset().mockResolvedValue({ status: 'ple_pass', criteria: {} });
  enqueueEvaluation.mockReset().mockResolvedValue(undefined);
  kick.mockReset();
});

const ZERO = { recovered: 0, repaired: 0, flagged: 0, failed: 0, requeued: 0, queued: 0, skipped: 0 };
const pleUpdates = () => mockWrites.filter(w => w.table === 'ples' && w.op === 'update');

test('a LEGACY ple_pass row (no queue position) is stamped with its ended_at and the drain kicked — never scored, never re-enqueued', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1', status: 'ple_pass', ended_at: '2026-09-01T00:00:00.000Z', eval_enqueued_at: null }];
  const result = await reconcileEvaluations();
  expect(enqueueEvaluation).not.toHaveBeenCalled();
  expect(finalizeScreening).not.toHaveBeenCalled();
  // Only the position timestamp — never claim / attempts / next_at, which belong to the drain.
  expect(pleUpdates().map(w => w.payload)).toEqual([{ eval_enqueued_at: '2026-09-01T00:00:00.000Z' }]);
  expect(kick).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ stuck: 1, ...ZERO, requeued: 1 });
});

test('a row ALREADY in the queue — even one claimed and in flight — is left untouched: no write, kick only', async () => {
  mockPles = [{ id: 'ple2', physician_id: 'doc1', status: 'ple_pass', ended_at: '2026-09-01T00:00:00.000Z',
    eval_enqueued_at: '2026-09-01T00:00:01.000Z', eval_claimed_at: '2026-09-01T00:05:00.000Z' }];
  const result = await reconcileEvaluations();
  expect(enqueueEvaluation).not.toHaveBeenCalled();
  expect(pleUpdates()).toEqual([]); // re-enqueueing here would reset its claim/attempts/backoff → a duplicate evaluation
  expect(kick).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ stuck: 1, ...ZERO, queued: 1 });
});

test("a stranded 'ended' session finishes tier-2 via finalizeScreening (recovered)", async () => {
  mockPles = [{ id: 'pleE', physician_id: 'doc1', status: 'ended', c1_pass: true, c2_pass: true, c3_pass: true }];
  mockMsgs = { pleE: [{ role: 'physician', content: 'x' }, { role: 'assistant', content: 'y' }] };
  const result = await reconcileEvaluations();
  expect(finalizeScreening).toHaveBeenCalledTimes(1);
  expect(finalizeScreening).toHaveBeenCalledWith(expect.objectContaining({
    pleId: 'pleE', physicianId: 'doc1', tier1: { c1: true, c2: true, c3: true },
  }));
  expect(enqueueEvaluation).not.toHaveBeenCalled(); // finalizeScreening enqueues on its own
  expect(result).toEqual({ stuck: 1, ...ZERO, recovered: 1 });
});

test('a PARTIAL persist (ai row exists, still ple_pass) is REPAIRED with no re-eval and no re-enqueue', async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1', status: 'ple_pass' }];
  mockMsgs = { ple1: [{ role: 'physician', content: 'x' }] };
  mockEvals = { ple1: { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 60 } };
  const result = await reconcileEvaluations();
  expect(enqueueEvaluation).not.toHaveBeenCalled();
  expect(mockWrites.some(w => w.table === 'lpdp_snapshots' && w.op === 'insert')).toBe(true); // snapshot backfilled
  expect(mockWrites.some(w => w.table === 'ples' && w.op === 'update' && w.payload.status === 'evaluated')).toBe(true);
  expect(result).toEqual({ stuck: 1, ...ZERO, repaired: 1 });
});

test('a failing finalize on one session counts as failed and the sweep continues to the next', async () => {
  mockPles = [
    { id: 'pleA', physician_id: 'doc1', status: 'ended', c1_pass: true, c2_pass: true, c3_pass: true },
    { id: 'pleB', physician_id: 'doc2', status: 'ple_pass' },
  ];
  mockMsgs = { pleA: [{ role: 'physician', content: 'x' }] };
  finalizeScreening.mockRejectedValueOnce(new Error('RIMPL down'));
  const result = await reconcileEvaluations();
  expect(pleUpdates().map(w => w.payload)).toEqual([{ eval_enqueued_at: expect.any(String) }]); // pleB still handled after pleA failed
  expect(result).toEqual({ stuck: 2, ...ZERO, failed: 1, requeued: 1 });
});

test("an 'ended' session with an empty/failed transcript is skipped (not scored) and counted as failed", async () => {
  mockPles = [{ id: 'ple1', physician_id: 'doc1', status: 'ended', c1_pass: true, c2_pass: true, c3_pass: true }];
  mockMsgs = { ple1: [] }; // no messages — must NOT screen an empty transcript into a bogus result
  const result = await reconcileEvaluations();
  expect(finalizeScreening).not.toHaveBeenCalled();
  expect(result).toEqual({ stuck: 1, ...ZERO, failed: 1 });
});

test('the sweep REFUSES to run when the council partition fails closed (unknown exclude code) — nothing touched', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'SANDBX' } }; // typo
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }];
  mockPles = [{ id: 'pleS', physician_id: 'doc1', status: 'ple_pass', council_id: 'c-sbx' }];
  await expect(reconcileEvaluations()).rejects.toThrow(/failed closed/);
  expect(pleUpdates()).toEqual([]);
  expect(kick).not.toHaveBeenCalled();
});

test('a council named in eval_drain_exclude_councils is left alone (skipped), the rest proceed', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'SANDBOX' } };
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }];
  mockPles = [
    { id: 'pleS', physician_id: 'doc1', status: 'ple_pass', council_id: 'c-sbx' },
    { id: 'pleR', physician_id: 'doc2', status: 'ple_pass', council_id: 'c-tmc' },
  ];
  const result = await reconcileEvaluations();
  expect(pleUpdates()).toHaveLength(1); // pleR stamped; pleS (SANDBOX) untouched
  expect(result).toEqual({ stuck: 2, ...ZERO, requeued: 1, skipped: 1 });
});
