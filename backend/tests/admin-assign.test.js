// Admin → Auditor handoff: POST /admin/cles/:id/assign guard branches + GET /admin/auditors scoping.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { ADMIN, SUPERADMIN, COUNCIL_A, COUNCIL_B } = require('./helpers/roles');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

// AssignSchema requires a UUID auditor_id (the caller id needn't be one — verifyJwt doesn't validate it).
const AUD_UUID = '22222222-2222-2222-2222-222222222222';

let cle, auditor, auditorsList;
beforeEach(() => {
  m.reset();
  m.state.caller = ADMIN; // council A
  cle = { id: 'p1', status: 'evaluated', council_id: COUNCIL_A, physician_id: 'phys-1' };
  auditor = { id: AUD_UUID, role: 'auditor', status: 'active', council_id: COUNCIL_A, can_audit: false };
  auditorsList = [{ id: AUD_UUID, full_name_th: 'ผ', full_name_en: 'Aud', role: 'auditor', can_audit: false, council_id: COUNCIL_A }];
  m.state.resolve = (table, kind) => {
    if (table === 'cles' && kind === 'single') return cle;
    if (table === 'professionals' && kind === 'single') return auditor; // the assignee lookup
    if (table === 'professionals' && kind === 'list') return auditorsList; // GET /admin/auditors
    return undefined; // cles update → {error:null}
  };
});

const assign = (auditor_id = AUD_UUID, cleId = 'p1') =>
  auth(request(app).post(`/admin/cles/${cleId}/assign`)).send({ auditor_id });
// the /admin/auditors query is the LAST professionals read (verifyJwt's caller lookup is the first).
const auditorsQuery = () => m.all('professionals').pop();

test('happy path: same-council active auditor → 200, auditor_id written, status-gated update', async () => {
  const r = await assign();
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  const upd = m.find('cles', 'update');
  expect(upd.payload).toEqual({ auditor_id: AUD_UUID });
  expect(upd.eqs).toContainEqual(['id', 'p1']);
  expect(upd.eqs).toContainEqual(['status', 'evaluated']); // atomic — only assigns while still evaluated
});

test('CLE not yet evaluated → 400, no assignment', async () => {
  cle.status = 'ended';
  const r = await assign();
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/not ready/i);
  expect(m.find('cles', 'update')).toBeUndefined();
});

test('a can_audit physician is a valid assignee → 200', async () => {
  auditor = { id: AUD_UUID, role: 'physician', status: 'active', council_id: COUNCIL_A, can_audit: true };
  const r = await assign();
  expect(r.status).toBe(200);
});

test('inactive auditor → 400 Not an active auditor', async () => {
  auditor.status = 'deactivated';
  const r = await assign();
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/active auditor/i);
});

test("assigning the session's own physician → 409", async () => {
  cle.physician_id = AUD_UUID; // the assignee would be the runner
  const r = await assign();
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/own session/i);
});

test('cross-council auditor → 409', async () => {
  auditor.council_id = COUNCIL_B;
  const r = await assign();
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/cross-council/i);
});

test('admin assigning a CLE outside their council → opaque 404', async () => {
  cle.council_id = COUNCIL_B; // admin is council A
  const r = await assign();
  expect(r.status).toBe(404);
  expect(m.find('cles', 'update')).toBeUndefined();
});

test('superadmin can assign across councils (sameCouncil is a no-op) → 200', async () => {
  m.state.caller = SUPERADMIN;
  cle.council_id = COUNCIL_B;
  auditor.council_id = COUNCIL_B; // assignee still must match the CLE council
  const r = await assign();
  expect(r.status).toBe(200);
});

test('reassign while still evaluated is allowed (no auditor_id pre-check) → 200', async () => {
  cle.auditor_id = 'someone-else';
  const r = await assign();
  expect(r.status).toBe(200);
});

test('GET /admin/auditors is council-scoped for an admin', async () => {
  const r = await auth(request(app).get('/admin/auditors'));
  expect(r.status).toBe(200);
  expect(auditorsQuery().eqs).toContainEqual(['council_id', COUNCIL_A]);
});

test('GET /admin/auditors is NOT council-scoped for a superadmin', async () => {
  m.state.caller = SUPERADMIN;
  const r = await auth(request(app).get('/admin/auditors'));
  expect(r.status).toBe(200);
  expect(auditorsQuery().eqs).not.toContainEqual(['council_id', expect.anything()]);
});

test('rejects a non-uuid auditor_id (zod) → 400', async () => {
  const r = await assign('not-a-uuid');
  expect(r.status).toBe(400);
});
