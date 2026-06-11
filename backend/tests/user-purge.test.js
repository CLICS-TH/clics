// PURGE — DELETE /admin/users/:id/purge hard-deletes a user + all their data (IRB erasure).
// The safety GUARDS are what matter most for an irreversible op: it must refuse a superadmin
// target, a still-active target, a name-mismatch, and a missing user — and only proceed (deleting
// the auth user) on a deactivated target with a matching confirm name.
//
// Mock note: BOTH verifyJwt (loads the caller by token id 'sa-1') and the route (loads the target
// by :id) call professionals.select().single(); the mock returns the CALLER for id 'sa-1' and the
// per-test target otherwise. Every other chain is a harmless thenable; auth.admin.deleteUser is a spy.
// jest.mock factories may only reference `mock`-prefixed module-scope vars.
const mockCaller = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null, can_audit: false };
let mockTarget = null;
const mockDeleteUser = jest.fn(() => Promise.resolve({ error: null }));

const mockThenable = (data = null) => {
  let lastId = null;
  const p = {
    eq(col, val) { if (col === 'id') lastId = val; return p; },
    select() { return p; },
    single: () => Promise.resolve({ data: lastId === mockCaller.id ? mockCaller : mockTarget, error: null }),
    then: (res, rej) => Promise.resolve({ data, error: null }).then(res, rej),
  };
  return p;
};

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => mockThenable(table === 'ples' ? [{ id: 'ple-1' }, { id: 'ple-2' }] : null),
      delete: () => mockThenable(null),
      update: () => mockThenable(null),
    }),
  },
  authSupabase: {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null }),
      admin: { deleteUser: (...a) => mockDeleteUser(...a) },
    },
  },
}));

const request = require('supertest');
const express = require('express');
const superadminRouter = require('../src/routes/superadmin');

const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
const purge = (id, body) => request(app).delete(`/admin/users/${id}/purge`).set('Authorization', 'Bearer t').send(body);

const PHYS = { id: 'phys-1', role: 'physician', status: 'deactivated', full_name_en: 'Dr Test Purge' };

beforeEach(() => { mockTarget = null; mockDeleteUser.mockClear(); });

test('deactivated target + matching name → 200, purges and deletes the auth user', async () => {
  mockTarget = { ...PHYS };
  const r = await purge('phys-1', { confirm_name: 'Dr Test Purge' });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ purged: true, deleted_ples: 2, auth_deleted: true });
  expect(mockDeleteUser).toHaveBeenCalledWith('phys-1');
});

test('superadmin target → 403, never deletes the auth user', async () => {
  mockTarget = { id: 'phys-1', role: 'superadmin', status: 'deactivated', full_name_en: 'Super' };
  const r = await purge('phys-1', { confirm_name: 'Super' });
  expect(r.status).toBe(403);
  expect(mockDeleteUser).not.toHaveBeenCalled();
});

test('still-active target → 409 (must deactivate first), no auth delete', async () => {
  mockTarget = { ...PHYS, status: 'active' };
  const r = await purge('phys-1', { confirm_name: 'Dr Test Purge' });
  expect(r.status).toBe(409);
  expect(mockDeleteUser).not.toHaveBeenCalled();
});

test('name mismatch → 400, no auth delete', async () => {
  mockTarget = { ...PHYS };
  const r = await purge('phys-1', { confirm_name: 'wrong name' });
  expect(r.status).toBe(400);
  expect(mockDeleteUser).not.toHaveBeenCalled();
});

test('missing user → 404', async () => {
  mockTarget = null;
  const r = await purge('nope', { confirm_name: 'x' });
  expect(r.status).toBe(404);
  expect(mockDeleteUser).not.toHaveBeenCalled();
});
