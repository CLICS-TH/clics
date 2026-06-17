// Audit trail (CLICS §9.4): scoring actions are recorded, and oversight can read the log.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/auditor', require('../src/routes/auditor'));
app.use('/superadmin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const AUDITOR = { id: 'aud1', role: 'auditor', council_id: 'cA', status: 'active', email: 'a@t', consented_at: '2026-01-01T00:00:00Z' };
const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 's@t' };
const FULL = { d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4 };

beforeEach(() => m.reset());

test('submitting an auditor score writes an audit_log row (action audit.score)', async () => {
  m.state.caller = AUDITOR;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'cles') return { id: 'u1', auditor_id: 'aud1', council_id: 'cA', physician_id: 'phys9' };
    if (table === 'audit_scores' && kind === 'single') return null; // no existing score
    return undefined; // audit_scores insert / audit_log insert → ok
  };
  const r = await auth(request(app).post('/auditor/cles/u1/score')).send(FULL);
  expect(r.status).toBe(200);
  const logged = m.find('audit_log', 'insert');
  expect(logged).toBeDefined();
  expect(logged.payload).toMatchObject({ action: 'audit.score', target_type: 'cle', target_id: 'u1' });
});

test('GET /superadmin/audit-log returns the events newest-first', async () => {
  m.state.caller = SUPER;
  m.state.resolve = (table, kind) => {
    if (table === 'audit_log' && kind === 'list') return { data: [{ id: 'e1', action: 'export' }], count: 1 };
    return undefined;
  };
  const r = await auth(request(app).get('/superadmin/audit-log'));
  expect(r.status).toBe(200);
  expect(r.body.events[0].action).toBe('export');
  expect(r.body.total).toBe(1);
});
