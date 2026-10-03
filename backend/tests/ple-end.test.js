// POST /ples/:id/end restructure (F4/F6/F8): the deterministic tier-1 result (duration, counts,
// c1-c3) is persisted IN the atomic claim, and tier-2 runs via finalizeScreening. A persistent RIMPL
// failure leaves the session at a RECOVERABLE 'ended' (202), never permanently stranded or wrongly
// flagged. Turn/token counts are derived from the messages rows, not the racy cached counters.
let mockPle;       // row returned by fetchOwnedPle
let mockMsgs;      // messages rows
let mockClaimed;   // rows returned by the atomic claim .select('id')
let mockUpdates;   // captured ples updates
let mockFinalize;  // finalizeScreening behavior

jest.mock('../src/middleware/auth', () => ({
  verifyJwt: (req, _res, next) => { req.user = { id: 'doc1', role: 'physician', consented_at: '2026-01-01T00:00:00Z' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));

jest.mock('../src/lib/db-helpers', () => ({
  fetchOwnedPle: () => Promise.resolve({ data: mockPle }),
  ownsFolder: () => Promise.resolve(true),
  sendDbError: (res, err) => { if (err) { res.status(500).json({ error: 'db' }); return true; } return false; },
}));

const mockFlagRefused = jest.fn(async () => {});
jest.mock('../src/services/ple-finalize', () => ({
  finalizeScreening: (...a) => mockFinalize(...a),
  flagRefusedScreening: (...a) => mockFlagRefused(...a),
  // real toPassCols so the persisted patch carries c1_pass..c3_pass
  toPassCols: (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v])),
}));

let mockT1Outcome;       // captured record_t1_outcome rpc args
let mockReflectRequired; // app_settings.reflection_required
let mockReflection;      // the ple_reflections row, or null
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    // Table-aware: /end now reads app_settings (reflection_required) and ple_reflections before it
    // decides whether to finalise, and a double that answered `null` to everything made every
    // session look like it was still awaiting a reflection.
    from: (table) => {
      let op = 'select';
      const single = () => {
        if (table === 'app_settings') return Promise.resolve({ data: { value: mockReflectRequired }, error: null });
        if (table === 'ple_reflections') return Promise.resolve({ data: mockReflection, error: null });
        return Promise.resolve({ data: null, error: null }); // ple_patient_refs → no ref in these tests
      };
      const c = {
        select: () => (op === 'update' ? Promise.resolve({ data: mockClaimed, error: null }) : c),
        update: (p) => { op = 'update'; mockUpdates.push(p); return c; },
        eq: () => c,
        order: () => Promise.resolve({ data: mockMsgs, error: null }),
        maybeSingle: single,
        single,
      };
      return c;
    },
    rpc: (fn, args) => { if (fn === 'record_t1_outcome') mockT1Outcome = args; return Promise.resolve({ data: null, error: null }); },
  },
  authSupabase: { auth: {} },
}));

const request = require('supertest');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const end = (id, body) => request(app).post(`/ples/${id}/end`).set('Authorization', 'Bearer t').send(body);

const longAgo = () => new Date(Date.now() - 1200_000).toISOString(); // 20 min → wall-clock passes C1
const qualifyingMsgs = () => ([
  { role: 'physician', content: 'a', token_count: 2500 }, { role: 'assistant', content: 'b', token_count: 0 },
  { role: 'physician', content: 'c', token_count: 2500 }, { role: 'assistant', content: 'd', token_count: 0 },
  { role: 'physician', content: 'e', token_count: 2500 }, { role: 'assistant', content: 'f', token_count: 0 },
  { role: 'physician', content: 'g', token_count: 2500 }, { role: 'assistant', content: 'h', token_count: 0 },
]);

beforeEach(() => {
  mockPle = { id: 'ple1', status: 'active', physician_id: 'doc1', started_at: longAgo(), socratic_reason: null, is_test: false };
  mockMsgs = qualifyingMsgs();
  mockClaimed = [{ id: 'ple1' }];
  mockUpdates = [];
  mockT1Outcome = undefined;
  // Most cases here are about the /end mechanics, so default the reflection OFF; the two cases that
  // are about the reflection turn it on explicitly.
  mockReflectRequired = 0;
  mockReflection = null;
  mockFinalize = jest.fn(async () => ({ status: 'ple_pass', criteria: { c1: true, c2: true, c3: true, c4: true, c5: true, c6: true } }));
});

test('a qualifying session claims to ended (tier-1 persisted) then finalizes to ple_pass', async () => {
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ple_pass');
  // The atomic claim persisted status='ended' + the deterministic tier-1 result (counts/c1-c3).
  const claim = mockUpdates[0];
  expect(claim.status).toBe('ended');
  expect(claim.turn_count).toBe(4);          // derived from messages, not the cached counter
  expect(claim.token_count).toBe(10000);
  expect(claim.c1_pass && claim.c2_pass && claim.c3_pass).toBe(true);
  expect(claim.duration_seconds).toBeLessThanOrEqual(1300); // clamped to wall-clock, not 999999
  expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({
    pleId: 'ple1', physicianId: 'doc1', tier1: { c1: true, c2: true, c3: true },
  }));
  // The consecutive-failure counter is NOT written here any more. Tier-1 stopped being a verdict,
  // so feeding it from /end would record a pass for every session that reached this point and reset
  // the counter forever. It now runs in ple-finalize.js off the qualifying result — see
  // tests/ple-finalize-counter.test.js.
  expect(mockT1Outcome).toBeUndefined();
});

test("a persistent tier-2 RIMPL failure leaves the session at recoverable 'ended' (202), not ple_flag_t2", async () => {
  mockFinalize = jest.fn(async () => { throw new Error('RIMPL down'); });
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('ended');
  expect(res.body.pending).toBe('tier2');
  // It must NOT have written a terminal ple_flag_t2 — reconcile will retry the 'ended' row.
  expect(mockUpdates.every(u => u.status !== 'ple_flag_t2')).toBe(true);
});

test('a REFUSED tier-2 classifier goes straight to manual QA (ple_flag_t2), not to reconcile', async () => {
  // Deterministic: reconcile would only pay for the same decline on its next sweep.
  mockFlagRefused.mockClear();
  mockFinalize = jest.fn(async () => { throw Object.assign(new Error('RIMPL /evaluate-criteria error: 422'), {
    status: 422, code: 'refused', category: 'bio', usage: { input_tokens: 5000, output_tokens: 1, provider: 'anthropic' } }); });
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ple_flag_t2');
  expect(mockFlagRefused).toHaveBeenCalledTimes(1);
  expect(mockFlagRefused.mock.calls[0][0]).toMatchObject({ pleId: 'ple1', err: expect.objectContaining({ code: 'refused' }) });
});

test('a SHORT session is no longer rejected — it reaches the qualifying classifier', async () => {
  // CREC082 §1 defines a qualifying PLE by four qualities, not by minutes or tokens. c1-c3 used to
  // terminate a session here at ple_fail_t1, which rejected a concise but genuinely reflective
  // episode unscored while passing a rambling factual lookup. They are recorded now, not enforced.
  mockPle.started_at = new Date().toISOString(); // wall-clock ~0 → c1 (>=600s) is false
  const res = await end('ple1', { active_seconds: 999999 }); // inflated value cannot beat wall-clock
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ple_pass');
  expect(mockUpdates[0].status).toBe('ended');
  expect(mockUpdates[0].c1_pass).toBe(false);   // recorded...
  expect(mockFinalize).toHaveBeenCalled();      // ...but it did not decide the outcome
});

test('a session with NO physician turn is the one remaining hard stop', async () => {
  // Not a quality bar: there is nothing to classify, so a paid classifier call would buy nothing.
  mockMsgs = [{ role: 'assistant', content: 'hello', token_count: 5 }];
  const res = await end('ple1', { active_seconds: 60 });
  expect(res.body.status).toBe('ple_fail_t1');
  expect(mockUpdates[0].status).toBe('ple_fail_t1');
  expect(mockFinalize).not.toHaveBeenCalled();
});

test('with a reflection pending, /end stops at ended and does NOT screen', async () => {
  // The reflection is scored evidence (PIS-7 is assessed on "transcript และ reflection", and the D6
  // anchor starts at "0: ไม่มี reflection"). Screening now would judge c6 — one of the four
  // qualifying elements — on a transcript the protocol says is incomplete.
  mockReflectRequired = 1;
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: 'ended', pending: 'reflection' });
  expect(mockFinalize).not.toHaveBeenCalled();
  // The claim still happened, so nothing is lost if the physician never comes back — 'ended' is
  // already the recoverable state reconcile sweeps.
  expect(mockUpdates[0].status).toBe('ended');
});

test('a reflection already on file lets /end screen straight through', async () => {
  mockReflectRequired = 1;
  mockReflection = { ple_id: 'ple1', learned: 'x', skipped: false };
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.body.status).toBe('ple_pass');
  expect(mockFinalize).toHaveBeenCalled();
  // ...and the reflection is IN the transcript that gets screened, tagged so the evaluator can tell
  // it from a chat turn rather than reading it as more conversation.
  const sent = mockFinalize.mock.calls[0][0].transcript;
  expect(sent.at(-1)).toMatchObject({ role: 'reflection' });
  expect(sent.at(-1).content).toContain('x');
});

test('a lost claim race (0 rows) returns 409 without evaluating', async () => {
  mockClaimed = []; // another request already flipped active->ended
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(409);
  expect(mockFinalize).not.toHaveBeenCalled();
});

// The "only a natural, real session feeds the counter" rule moved to ple-finalize.js along with the
// counter itself; see tests/ple-finalize-counter.test.js. finalizeScreening is mocked in this suite,
// so there is nothing left to assert about it here.
