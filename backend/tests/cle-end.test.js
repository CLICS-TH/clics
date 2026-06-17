// POST /cles/:id/end restructure (F4/F6/F8): the deterministic tier-1 result (duration, counts,
// c1-c3) is persisted IN the atomic claim, and tier-2 runs via finalizeScreening. A persistent RIMPL
// failure leaves the session at a RECOVERABLE 'ended' (202), never permanently stranded or wrongly
// flagged. Turn/token counts are derived from the messages rows, not the racy cached counters.
let mockPle;       // row returned by fetchOwnedPle
let mockMsgs;      // messages rows
let mockClaimed;   // rows returned by the atomic claim .select('id')
let mockUpdates;   // captured cles updates
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

jest.mock('../src/services/cle-finalize', () => ({
  finalizeScreening: (...a) => mockFinalize(...a),
  // real toPassCols so the persisted patch carries c1_pass..c3_pass
  toPassCols: (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v])),
}));

let mockT1Outcome;  // captured record_t1_outcome rpc args
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let op = 'select';
      const c = {
        select: () => (op === 'update' ? Promise.resolve({ data: mockClaimed, error: null }) : c),
        update: (p) => { op = 'update'; mockUpdates.push(p); return c; },
        eq: () => c,
        order: () => Promise.resolve({ data: mockMsgs, error: null }),
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
app.use('/cles', require('../src/routes/cles'));
const end = (id, body) => request(app).post(`/cles/${id}/end`).set('Authorization', 'Bearer t').send(body);

const longAgo = () => new Date(Date.now() - 1200_000).toISOString(); // 20 min → wall-clock passes C1
const qualifyingMsgs = () => ([
  { role: 'physician', content: 'a', token_count: 250 }, { role: 'assistant', content: 'b', token_count: 0 },
  { role: 'physician', content: 'c', token_count: 250 }, { role: 'assistant', content: 'd', token_count: 0 },
  { role: 'physician', content: 'e', token_count: 250 }, { role: 'assistant', content: 'f', token_count: 0 },
  { role: 'physician', content: 'g', token_count: 250 }, { role: 'assistant', content: 'h', token_count: 0 },
]);

beforeEach(() => {
  mockPle = { id: 'ple1', status: 'active', physician_id: 'doc1', started_at: longAgo() };
  mockMsgs = qualifyingMsgs();
  mockClaimed = [{ id: 'ple1' }];
  mockUpdates = [];
  mockT1Outcome = undefined;
  mockFinalize = jest.fn(async () => ({ status: 'cle_pass', criteria: { c1: true, c2: true, c3: true, c4: true, c5: true, c6: true } }));
});

test('a qualifying session claims to ended (tier-1 persisted) then finalizes to cle_pass', async () => {
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('cle_pass');
  // The atomic claim persisted status='ended' + the deterministic tier-1 result (counts/c1-c3).
  const claim = mockUpdates[0];
  expect(claim.status).toBe('ended');
  expect(claim.turn_count).toBe(4);          // derived from messages, not the cached counter
  expect(claim.token_count).toBe(1000);
  expect(claim.c1_pass && claim.c2_pass && claim.c3_pass).toBe(true);
  expect(claim.duration_seconds).toBeLessThanOrEqual(1300); // clamped to wall-clock, not 999999
  expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({
    cleId: 'ple1', physicianId: 'doc1', tier1: { c1: true, c2: true, c3: true },
  }));
  // Tier-1 passed → the remediation counter is reset (CLICS §6.4).
  expect(mockT1Outcome).toEqual({ p_id: 'doc1', p_pass: true });
});

test("a persistent tier-2 RIMPL failure leaves the session at recoverable 'ended' (202), not cle_flag_t2", async () => {
  mockFinalize = jest.fn(async () => { throw new Error('RIMPL down'); });
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('ended');
  expect(res.body.pending).toBe('tier2');
  // It must NOT have written a terminal cle_flag_t2 — reconcile will retry the 'ended' row.
  expect(mockUpdates.every(u => u.status !== 'cle_flag_t2')).toBe(true);
});

test('a too-short session fails tier-1 (claim writes cle_fail_t1, no tier-2 call)', async () => {
  mockPle.started_at = new Date().toISOString(); // wall-clock ~0 → C1 (>=900s) fails
  const res = await end('ple1', { active_seconds: 999999 }); // inflated value cannot beat wall-clock
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('cle_fail_t1');
  expect(mockUpdates[0].status).toBe('cle_fail_t1');
  expect(mockFinalize).not.toHaveBeenCalled();
  // Tier-1 failed → the remediation counter is incremented (CLICS §6.4).
  expect(mockT1Outcome).toEqual({ p_id: 'doc1', p_pass: false });
});

test('a lost claim race (0 rows) returns 409 without evaluating', async () => {
  mockClaimed = []; // another request already flipped active->ended
  const res = await end('ple1', { active_seconds: 999999 });
  expect(res.status).toBe(409);
  expect(mockFinalize).not.toHaveBeenCalled();
});
