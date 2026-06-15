// Auditor scoring seam: queue filter, the server-side BLIND-SCORING invariant, score guards
// (assigned / not-own / same-council), double-submit 409, and the ICC endpoint.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { AUDITOR, COUNCIL_A, COUNCIL_B } = require('./helpers/roles');

const auditorRouter = require('../src/routes/auditor');
const app = express();
app.use(express.json());
app.use('/auditor', auditorRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const SCORES = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 }; // composite = 3 * 1.0 * 20 = 60

let ple, existingScore, aiEval, queue, scoredRows, insertError;
beforeEach(() => {
  m.reset();
  m.state.caller = AUDITOR; // aud-1, council A
  ple = { id: 'p1', status: 'evaluated', auditor_id: AUDITOR.id, council_id: COUNCIL_A, physician_id: 'phys-1', turn_count: 5, token_count: 900, ended_at: 't' };
  existingScore = null;
  aiEval = { ple_id: 'p1', d1: 4, composite_score: 70 };
  queue = [{ id: 'p1', status: 'evaluated', ended_at: 't', turn_count: 5, token_count: 900 }];
  scoredRows = [];
  insertError = null;
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'list') return queue;             // GET /queue
    if (table === 'ples') return ple;                                  // score / detail lookup = single
    if (table === 'messages') return [];
    if (table === 'audit_scores' && kind === 'list') return scoredRows; // queue scored-flag / icc
    if (table === 'audit_scores' && kind === 'single') return existingScore;
    if (table === 'audit_scores' && kind === 'insert') return { error: insertError };
    if (table === 'ai_evaluations') return aiEval;
    return undefined;
  };
});

test('GET /queue returns assigned evaluated PLEs with a scored flag', async () => {
  scoredRows = []; // none scored yet
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveLength(1);
  expect(r.body[0]).toMatchObject({ id: 'p1', scored: false });
  const q = m.find('ples');
  expect(q.eqs).toContainEqual(['auditor_id', AUDITOR.id]);
  expect(q.eqs).toContainEqual(['status', 'evaluated']);
});

test('BLIND: GET /auditor/ples/:id hides the AI score until the auditor has submitted', async () => {
  existingScore = null; // not yet scored
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.ai_evaluation).toBeNull();   // <- the invariant, enforced server-side
  expect(r.body.audit_score).toBeNull();
});

test('REVEAL: once a score exists, the AI evaluation is returned', async () => {
  existingScore = { id: 's1', ple_id: 'p1', composite_score: 60 };
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.audit_score).toMatchObject({ id: 's1' });
  expect(r.body.ai_evaluation).toMatchObject({ ple_id: 'p1', composite_score: 70 });
});

test('GET /auditor/ples/:id not assigned to me → 404', async () => {
  ple = null; // the eq(auditor_id=me) filter returns nothing
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(404);
});

test('POST score (happy) → 200 with computed composite; insert carries auditor_id + scores', async () => {
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(200);
  expect(r.body.composite_score).toBe(60);
  const ins = m.find('audit_scores', 'insert');
  expect(ins.payload).toMatchObject({ ple_id: 'p1', auditor_id: AUDITOR.id, d1: 3, composite_score: 60 });
});

test('double-submit (existing score) → 409, no insert', async () => {
  existingScore = { id: 's1' };
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

test('concurrent double-submit surfacing as 23505 from the unique constraint → 409', async () => {
  existingScore = null;          // friendly pre-check passes
  insertError = { code: '23505' }; // the DB unique backstop fires
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
});

test('scoring a session not assigned to me → 403', async () => {
  ple.auditor_id = 'other-auditor';
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/not assigned/i);
});

test('scoring your own session → 403', async () => {
  ple.physician_id = AUDITOR.id;
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/own session/i);
});

test('cross-council scoring → 403', async () => {
  ple.council_id = COUNCIL_B;
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/cross-council/i);
});

test('out-of-range domain score → 400 (zod)', async () => {
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send({ ...SCORES, d1: 9 });
  expect(r.status).toBe(400);
});

test('GET /auditor/icc returns an ICC object over the auditor\'s scored pairs', async () => {
  scoredRows = [{ ple_id: 'p1', composite_score: 60 }];
  aiEval = [{ ple_id: 'p1', composite_score: 62 }]; // ai_evaluations .in() list
  const r = await auth(request(app).get('/auditor/icc'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('icc');
});
