// SEAMLESS COOPERATION centerpiece: one flow across the real admin + auditor routers, switching the
// acting role between requests, proving the handoff chain connects end-to-end:
//   admin assigns an evaluated PLE → auditor sees it blind (AI score hidden) → auditor scores
//   → the AI score is revealed → ICC pairs AI vs auditor.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { ADMIN, COUNCIL_A } = require('./helpers/roles');

const adminRouter = require('../src/routes/admin');
const auditorRouter = require('../src/routes/auditor');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use('/auditor', auditorRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const AUD_UUID = '44444444-4444-4444-4444-444444444444';
const AUDITOR_ACTOR = { id: AUD_UUID, email: 'aud@test.local', role: 'auditor', status: 'active', council_id: COUNCIL_A, consented_at: '2026-01-01T00:00:00Z' };
// The route requires the approved form's pre-submit confirmations. Derived from the schema rather
// than duplicated, so a change to the checklist does not incidentally break a suite that is not
// about the checklist at all.
const { SCORE_ATTESTATIONS } = require('../src/lib/schemas');
const ATTEST = Object.fromEntries(SCORE_ATTESTATIONS.map((k) => [k, true]));
const SCORES = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, attestations: ATTEST }; // composite 60

test('physician→admin→auditor handoff chain connects end-to-end', async () => {
  // Shared, evolving state across the role switches.
  // privacy_review_status: CREC082's human privacy gate blocks assignment until a person has
  // cleared the transcript (lib/privacy-review.js). It fails CLOSED, so a fixture without this
  // field is correctly refused — these suites are about assignment rules, not the gate.
  const ple = { id: 'p1', status: 'evaluated', council_id: COUNCIL_A, physician_id: 'phys-1', auditor_id: null, turn_count: 5, token_count: 900, ended_at: 't', privacy_review_status: 'passed' };
  let scored = false;
  const aiEvalSingle = { ple_id: 'p1', d1: 4, composite_score: 70 };

  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') return ple;                              // assign single, auditor detail/score single
    if (table === 'professionals' && kind === 'single') return { id: AUD_UUID, role: 'auditor', status: 'active', council_id: COUNCIL_A, can_audit: false };
    if (table === 'messages') return [];
    if (table === 'audit_scores') {
      if (ctx.op === 'insert') { scored = true; return { error: null }; }
      if (kind === 'list') return scored ? [{ ple_id: 'p1', composite_score: 60 }] : [];
      return scored ? { id: 's1', ple_id: 'p1', composite_score: 60 } : null; // existing-score check
    }
    if (table === 'ai_evaluations') return kind === 'list' ? [{ ple_id: 'p1', composite_score: 62 }] : aiEvalSingle;
    return undefined; // ples update → ok
  };

  // 1) ADMIN assigns the evaluated PLE to the auditor.
  m.state.caller = ADMIN;
  const assigned = await auth(request(app).post('/admin/ples/p1/assign')).send({ auditor_id: AUD_UUID });
  expect(assigned.status).toBe(200);
  ple.auditor_id = AUD_UUID; // the assignment now persists (auditor_id set)

  // 2) AUDITOR opens it — BLIND: the AI score must be hidden before they submit.
  m.state.caller = AUDITOR_ACTOR;
  const before = await auth(request(app).get('/auditor/ples/p1'));
  expect(before.status).toBe(200);
  expect(before.body.ai_evaluation).toBeNull();
  expect(before.body.audit_score).toBeNull();

  // 3) AUDITOR scores it.
  const scoredRes = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(scoredRes.status).toBe(200);
  expect(scoredRes.body.composite_score).toBe(60);

  // 4) Now the AI score is revealed (and their own score is attached).
  const after = await auth(request(app).get('/auditor/ples/p1'));
  expect(after.body.audit_score).toMatchObject({ composite_score: 60 });
  expect(after.body.ai_evaluation).toMatchObject({ composite_score: 70 });

  // 5) ICC pairs the AI score against the auditor score.
  const icc = await auth(request(app).get('/auditor/icc'));
  expect(icc.status).toBe(200);
  expect(icc.body).toHaveProperty('icc');
});
