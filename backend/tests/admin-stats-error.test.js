// GET /admin/stats — a READ ERROR MUST NOT RENDER AS AN EMPTY STUDY.
//
// The endpoint counts sessions by status via the `ple_status_counts` RPC and falls back to a JS
// count when that RPC is unavailable (the pre-migration path). The fallback used to drop its own
// error on the floor and answer `200 {total: 0}` regardless — an admin console that looks perfectly
// healthy while reporting a study with nothing in it.
//
// That is not hypothetical. Between 2026-08-31 and 2026-09-02 production's session table had been
// renamed out from under the deployed code: every session query was failing, and this endpoint was
// the one screen that did not say so. It answered zero, and zero looked like an answer.
//
// So: a successful read reports counts, and a failed read reports 500. Never a fabricated zero.

jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const ADMIN_C1 = { id: 'adm-1', role: 'admin', status: 'active', council_id: 'C1' };

// The mock's rpc() always resolves {data: null, error: null}, so Array.isArray(null) is false and
// every test here exercises the JS fallback — which is the path under test.
beforeEach(() => {
  m.reset();
  m.state.caller = ADMIN_C1;
});

test('fallback read succeeds → 200 with per-status counts and a real total', async () => {
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'list')
      ? { data: [{ status: 'evaluated' }, { status: 'evaluated' }, { status: 'active' }], error: null }
      : undefined;

  const res = await auth(request(app).get('/admin/stats'));

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ total: 3, evaluated: 2, active: 1 });
});

test('fallback read FAILS → 500, not 200 with a fabricated total of 0', async () => {
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'list')
      ? { data: null, error: { message: 'relation "public.ples" does not exist' } }
      : undefined;

  const res = await auth(request(app).get('/admin/stats'));

  // The regression this file exists for: a 200 here means the console shows an empty study.
  expect(res.status).not.toBe(200);
  expect(res.status).toBe(500);
  expect(res.body.total).toBeUndefined();
  expect(res.body.error).toBeDefined();
});

test('a genuinely empty study still reports 200 with total 0 (zero is only an answer when it is one)', async () => {
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'list') ? { data: [], error: null } : undefined;

  const res = await auth(request(app).get('/admin/stats'));

  expect(res.status).toBe(200);
  expect(res.body.total).toBe(0);
});
