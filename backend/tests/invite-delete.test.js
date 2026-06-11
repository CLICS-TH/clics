// DELETE /admin/invites/:id — "delete invite history" semantics (src/routes/admin.js):
//   - status 'pending'                      → soft revoke (update status:'revoked'), { ok: true }
//   - any other status (revoked/accepted/
//     expired — i.e. a history row)         → HARD delete the row, { deleted: true }
//   - council scoping: an admin may only touch invites in their OWN council (404 otherwise,
//     same shape as a missing row so cross-council ids are not enumerable); superadmin any.
//
// Supabase mock follows invite-email/invite-special (table-aware; ALL mutable state inside the
// hoisted jest.mock factory, re-exported as `__mock`); update/delete calls are recorded so each
// test can assert WHICH mutation ran (revoke vs hard delete) — not just the response body.

jest.mock('../src/lib/supabase', () => {
  const state = {
    caller: null,    // professionals .single() → verifyJwt row
    invite: null,    // invites .select(...).single() → the row the route fetches (null = 404)
    updates: [],     // recorded update payloads per table: { table, payload }
    deletes: [],     // tables that received a .delete()
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const self = { _op: 'select' };
    for (const fn of ['select', 'eq', 'neq', 'order', 'not', 'is', 'range', 'limit', 'gte', 'lte', 'in']) self[fn] = () => self;
    self.update = (payload) => { self._op = 'update'; state.updates.push({ table, payload }); return self; };
    self.delete = () => { self._op = 'delete'; state.deletes.push(table); return self; };
    self.single = () => {
      if (table === 'professionals') return ok(state.caller);  // verifyJwt lookup
      if (table === 'invites') return ok(state.invite);        // the route's fetch-first
      return ok(null);
    };
    self.maybeSingle = () => ok(null);
    // Thenable terminal: both the revoke update and the hard delete end in .eq(...) awaited directly.
    self.then = (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
    return self;
  }

  const mod = {
    supabase: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
    authSupabase: { auth: {
      getUser: () => Promise.resolve(
        state.caller
          ? { data: { user: { id: state.caller.id, email: 'caller@test.local' } }, error: null }
          : { data: { user: null }, error: { message: 'no caller set' } }
      ),
    } },
  };
  mod.__mock = {
    state,
    reset() { state.caller = null; state.invite = null; state.updates.length = 0; state.deletes.length = 0; },
  };
  return mod;
});

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const COUNCIL_A = '11111111-1111-1111-1111-111111111111';
const COUNCIL_B = '22222222-2222-2222-2222-222222222222';
const SUPERADMIN = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null };
const ADMIN_A = { id: 'adm-1', role: 'admin', status: 'active', council_id: COUNCIL_A };

const invite = (status, council_id = COUNCIL_A) => ({ id: 'inv-1', council_id, status });
const del = () => auth(request(app).delete('/admin/invites/inv-1'));

beforeEach(() => m.reset());

test('pending → revoked (soft): { ok: true }, status update — NO hard delete', async () => {
  m.state.caller = SUPERADMIN;
  m.state.invite = invite('pending');

  const r = await del();

  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(m.state.updates).toEqual([{ table: 'invites', payload: { status: 'revoked' } }]);
  expect(m.state.deletes).toHaveLength(0);
});

test('revoked → HARD delete: { deleted: true }, row deleted — NO status update', async () => {
  m.state.caller = SUPERADMIN;
  m.state.invite = invite('revoked');

  const r = await del();

  expect(r.status).toBe(200);
  expect(r.body).toEqual({ deleted: true });
  expect(m.state.deletes).toEqual(['invites']);
  expect(m.state.updates).toHaveLength(0);
});

test.each(['accepted', 'expired'])('%s (history row) → HARD delete with { deleted: true }', async (status) => {
  m.state.caller = SUPERADMIN;
  m.state.invite = invite(status);

  const r = await del();

  expect(r.status).toBe(200);
  expect(r.body).toEqual({ deleted: true });
  expect(m.state.deletes).toEqual(['invites']);
  expect(m.state.updates).toHaveLength(0);
});

test("admin CANNOT delete another council's invite → 404, no mutation at all", async () => {
  m.state.caller = ADMIN_A;
  m.state.invite = invite('revoked', COUNCIL_B);   // exists, but outside the admin's council

  const r = await del();

  expect(r.status).toBe(404);                      // same shape as a missing row — not enumerable
  expect(m.state.updates).toHaveLength(0);
  expect(m.state.deletes).toHaveLength(0);
});

test('admin CAN revoke a pending invite in their OWN council', async () => {
  m.state.caller = ADMIN_A;
  m.state.invite = invite('pending', COUNCIL_A);

  const r = await del();

  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(m.state.updates).toEqual([{ table: 'invites', payload: { status: 'revoked' } }]);
});

test('unknown invite id → 404', async () => {
  m.state.caller = SUPERADMIN;
  m.state.invite = null;

  const r = await del();

  expect(r.status).toBe(404);
  expect(m.state.updates).toHaveLength(0);
  expect(m.state.deletes).toHaveLength(0);
});
