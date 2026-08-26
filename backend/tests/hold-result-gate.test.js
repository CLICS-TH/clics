// "Hold result until audited" (blinded test round): when the toggle is ON, GET /cles/:id/evaluation
// must withhold the physician's score (202 pending_review) until an auditor has scored that CLE.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const clesRouter = require('../src/routes/cles');
const app = express();
app.use(express.json());
app.use('/cles', clesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

const physician = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z' };
const EVAL = { cle_id: 'cle1', composite_score: 82, d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {} };

// hold: app_settings value for 'hold_result_until_audited'; audited: an audit_scores row or null.
function wire({ hold, audited }) {
  m.reset();
  m.state.caller = physician;
  m.state.resolve = (table, kind) => {
    if (table === 'cles') return { id: 'cle1', status: 'evaluated', physician_id: 'doc1' };
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
  const res = await auth(request(app).get('/cles/cle1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body.status).toBe('pending_review');
  expect(res.body.composite_score).toBeUndefined();
});

test('hold ON + an auditor has scored → 200 with the score revealed', async () => {
  wire({ hold: 1, audited: true });
  const res = await auth(request(app).get('/cles/cle1/evaluation'));
  expect(res.status).toBe(200);
  expect(res.body.composite_score).toBe(82);
});

test('hold OFF → 200 with the score, regardless of audit state', async () => {
  wire({ hold: 0, audited: false });
  const res = await auth(request(app).get('/cles/cle1/evaluation'));
  expect(res.status).toBe(200);
  expect(res.body.composite_score).toBe(82);
});
