// Tier-3/Tier-4 oversight access (CLICS §9.4): analyst sees aggregates but NOT the audit log;
// ethics sees the audit log; physicians/auditors are shut out entirely.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/oversight', require('../src/routes/oversight'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const ANALYST = { id: 'an1', role: 'analyst', status: 'active', council_id: null, email: 'an@t' };
const ETHICS = { id: 'et1', role: 'ethics', status: 'active', council_id: null, email: 'et@t' };
const PHYS = { id: 'p1', role: 'physician', status: 'active', council_id: 'cA', email: 'p@t' };

beforeEach(() => { m.reset(); m.state.resolve = () => undefined; });

test('analyst can read aggregate stats', async () => {
  m.state.caller = ANALYST;
  const r = await auth(request(app).get('/oversight/stats'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('counts');
});

test('analyst is BLOCKED from the audit log (Tier-4 only)', async () => {
  m.state.caller = ANALYST;
  const r = await auth(request(app).get('/oversight/audit-log'));
  expect(r.status).toBe(403);
});

test('ethics can read the audit log', async () => {
  m.state.caller = ETHICS;
  m.state.resolve = (table, kind) => (table === 'audit_log' && kind === 'list' ? { data: [{ id: 'e', action: 'export' }], count: 1 } : undefined);
  const r = await auth(request(app).get('/oversight/audit-log'));
  expect(r.status).toBe(200);
  expect(r.body.events[0].action).toBe('export');
});

test('a physician cannot reach oversight at all', async () => {
  m.state.caller = PHYS;
  const r = await auth(request(app).get('/oversight/stats'));
  expect(r.status).toBe(403);
});
