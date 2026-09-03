// Role-access matrix + dual-role + council scoping — the "who can reach what" half of seamless
// cooperation. Each router's requireRole gate, the can_audit ("special") pass-through, and that an
// admin's reads stay council-scoped while a superadmin's don't.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN, SPECIAL, AUDITOR, ADMIN, SUPERADMIN, COUNCIL_A } = require('./helpers/roles');

const adminRouter = require('../src/routes/admin');
const auditorRouter = require('../src/routes/auditor');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use('/auditor', auditorRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  m.reset();
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'list') return [];        // auditor queue
    if (table === 'audit_scores' && kind === 'list') return []; // queue scored-flag
    if (table === 'professionals' && kind === 'list') return []; // /admin/auditors
    return undefined;
  };
});

// --- auditor console: requireRole('auditor') + the can_audit pass-through ---
test('a pure auditor reaches the auditor queue → 200', async () => {
  m.state.caller = AUDITOR;
  expect((await auth(request(app).get('/auditor/queue'))).status).toBe(200);
});

test('a "special" physician (can_audit) reaches the auditor queue → 200 (dual role)', async () => {
  m.state.caller = SPECIAL;
  expect((await auth(request(app).get('/auditor/queue'))).status).toBe(200);
});

test('a plain physician is blocked from the auditor queue → 403', async () => {
  m.state.caller = PHYSICIAN;
  expect((await auth(request(app).get('/auditor/queue'))).status).toBe(403);
});

test('an admin is blocked from the auditor queue → 403', async () => {
  m.state.caller = ADMIN;
  expect((await auth(request(app).get('/auditor/queue'))).status).toBe(403);
});

// --- admin console: requireRole('admin','superadmin') ---
test('admin reaches /admin/auditors → 200; physician and auditor are blocked → 403', async () => {
  m.state.caller = ADMIN;
  expect((await auth(request(app).get('/admin/auditors'))).status).toBe(200);
  m.state.caller = PHYSICIAN;
  expect((await auth(request(app).get('/admin/auditors'))).status).toBe(403);
  m.state.caller = AUDITOR;
  expect((await auth(request(app).get('/admin/auditors'))).status).toBe(403);
});

// --- council scoping: admin reads are pinned to their council; superadmin sees all ---
test('admin reads are council-scoped; superadmin reads are not', async () => {
  m.state.caller = ADMIN;
  await auth(request(app).get('/admin/auditors'));
  expect(m.all('professionals').pop().eqs).toContainEqual(['council_id', COUNCIL_A]);

  m.reset();
  m.state.resolve = (t, k) => (t === 'professionals' && k === 'list' ? [] : undefined);
  m.state.caller = SUPERADMIN;
  await auth(request(app).get('/admin/auditors'));
  expect(m.all('professionals').pop().eqs).not.toContainEqual(['council_id', expect.anything()]);
});

// --- account lifecycle gate ---
test('a deactivated account is rejected at verifyJwt → 403', async () => {
  m.state.caller = { ...AUDITOR, status: 'deactivated' };
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('deactivated');
});
