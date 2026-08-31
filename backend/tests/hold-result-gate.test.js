// "Hold result until audited" (blinded test round): when the toggle is ON, GET /ples/:id/evaluation
// must withhold the physician's score (202 pending_review) until an auditor has scored that PLE.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

const physician = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z' };
const EVAL = { ple_id: 'cle1', composite_score: 82, d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {} };

// hold: app_settings value for 'hold_result_until_audited'; audited: an audit_scores row or null.
function wire({ hold, audited }) {
  m.reset();
  m.state.caller = physician;
  m.state.resolve = (table, kind) => {
    if (table === 'ples') return { id: 'cle1', status: 'evaluated', physician_id: 'doc1' };
    // Two different shapes are read from this table: getSetting() takes ONE row via .maybeSingle(),
    // while creditSettings() batches a .in([...]) list. Answering both with a single row made the
    // credit block throw inside the async handler, which returns no response at all.
    if (table === 'app_settings') {
      return kind === 'list'
        ? { data: [{ key: 'credit_conversion_enabled', value: 0 }] }   // credit OFF, the shipped default
        : { value: hold };                                            // hold_result_until_audited
    }
    if (table === 'audit_scores') return audited ? { id: 'as1' } : null;
    if (table === 'ai_evaluations') return EVAL;
    return undefined;
  };
}

test('hold ON + no auditor score → 202 pending_review (score withheld)', async () => {
  wire({ hold: 1, audited: false });
  const res = await auth(request(app).get('/ples/cle1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('pending_review');
  expect(res.body.composite_score).toBeUndefined();
});

test('hold ON + an auditor has scored → 200 with the score revealed', async () => {
  wire({ hold: 1, audited: true });
  const res = await auth(request(app).get('/ples/cle1/evaluation'));
  expect(res.status).toBe(200);
  expect(res.body.composite_score).toBe(82);
});

test('hold OFF → 200 with the score, regardless of audit state', async () => {
  wire({ hold: 0, audited: false });
  const res = await auth(request(app).get('/ples/cle1/evaluation'));
  expect(res.status).toBe(200);
  expect(res.body.composite_score).toBe(82);
});

// ---- LPDP: the hold must be distinguishable from having done nothing --------------------------
// GET /ples/lpdp/me drops snapshots for episodes no auditor has scored. It used to return a bare
// array, so the portal could not tell "you have no episodes" from "your episodes are withheld" —
// and told a physician whose work was in the audit queue to go "pass an episode first". With
// ?held=1 the response carries `held`, the count of that physician's own episodes being withheld.
//
// The bare path must KEEP returning the array: the portal and this API deploy separately, and an
// older cached lpdp.html tests `!data.length`, which on an object is true — so changing the
// default shape would show every physician the empty state during the deploy window.
const SNAPS = [
  { ple_id: 'pleA', composite_score: 70, snapshot_at: '2026-08-01T00:00:00Z' },
  { ple_id: 'pleB', composite_score: 80, snapshot_at: '2026-08-02T00:00:00Z' },
];

function wireLpdp({ hold, scored = [], snaps = SNAPS }) {
  m.reset();
  m.state.caller = physician;
  m.state.resolve = (table, kind) => {
    if (table === 'lpdp_snapshots') return { data: snaps };
    if (table === 'app_settings') return kind === 'list' ? { data: [] } : { value: hold };
    if (table === 'audit_scores') return { data: scored.map(ple_id => ({ ple_id })) };
    return undefined;
  };
}

test('LPDP hold ON + nothing scored → no snapshots, but held reports both episodes', async () => {
  wireLpdp({ hold: 1, scored: [] });
  const res = await auth(request(app).get('/ples/lpdp/me?held=1'));
  expect(res.status).toBe(200);
  expect(res.body.snapshots).toEqual([]);
  expect(res.body.held).toBe(2);
});

test('LPDP hold ON + one scored → that one is released, the other still counted as held', async () => {
  wireLpdp({ hold: 1, scored: ['pleA'] });
  const res = await auth(request(app).get('/ples/lpdp/me?held=1'));
  expect(res.body.snapshots).toHaveLength(1);
  expect(res.body.snapshots[0].ple_id).toBe('pleA');
  expect(res.body.held).toBe(1);
});

test('LPDP hold OFF → everything released and held is 0', async () => {
  wireLpdp({ hold: 0, scored: [] });
  const res = await auth(request(app).get('/ples/lpdp/me?held=1'));
  expect(res.body.snapshots).toHaveLength(2);
  expect(res.body.held).toBe(0);
});

// The distinction the whole change exists for: a genuinely empty profile must NOT look held, or
// the portal swaps one wrong message for the other.
test('LPDP with no episodes at all → empty and held 0, even with the hold ON', async () => {
  wireLpdp({ hold: 1, scored: [], snaps: [] });
  const res = await auth(request(app).get('/ples/lpdp/me?held=1'));
  expect(res.body.snapshots).toEqual([]);
  expect(res.body.held).toBe(0);
});

// The deploy-skew contract, stated as a test because it is the thing that breaks silently and for
// everyone at once: a client that does not ask for the new shape gets exactly what it always got.
test('LPDP without ?held=1 → the bare array, unchanged, so a cached portal keeps working', async () => {
  wireLpdp({ hold: 1, scored: ['pleA'] });
  const res = await auth(request(app).get('/ples/lpdp/me'));
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].ple_id).toBe('pleA');
});

test('LPDP without ?held=1 and hold OFF → the bare array of everything', async () => {
  wireLpdp({ hold: 0, scored: [] });
  const res = await auth(request(app).get('/ples/lpdp/me'));
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body).toHaveLength(2);
});
