// Superadmin is a locked singleton: its role + status are immutable (even self-targeted), it can't be
// created/assigned via the API, and specialty/license stay optional. Mock both supabase clients so the
// router + verifyJwt import cleanly and the target row reads as a superadmin.
let mockProf = { data: { id: 'sa-1', role: 'superadmin', status: 'active' }, error: null };
let mockUser = { data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null };

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve(mockProf),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
        order: () => Promise.resolve({ data: [], error: null }),
      }),
      update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: mockProf.data, error: null }) }) }) }),
    }),
  },
  authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
}));

const request = require('supertest');
const express = require('express');
const superadminRouter = require('../src/routes/superadmin');

const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
const auth = r => r.set('Authorization', 'Bearer test-token');

beforeEach(() => {
  mockProf = { data: { id: 'sa-1', role: 'superadmin', status: 'active' }, error: null };
  mockUser = { data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null };
});

// ---- schema invariants (no HTTP) ----
const { CreateUserSchema, UpdateUserSchema } = superadminRouter;
const baseUser = { email: 'a@b.co', password: 'longenough1', full_name_th: 'ก', full_name_en: 'A' };

test('CreateUserSchema rejects role=superadmin (cannot create a 2nd)', () => {
  expect(CreateUserSchema.safeParse({ ...baseUser, role: 'superadmin' }).success).toBe(false);
});
test('CreateUserSchema accepts a user with specialty + license_number OMITTED', () => {
  expect(CreateUserSchema.safeParse({ ...baseUser, role: 'physician' }).success).toBe(true);
});
test('UpdateUserSchema rejects role=superadmin (cannot promote to superadmin)', () => {
  expect(UpdateUserSchema.safeParse({ role: 'superadmin' }).success).toBe(false);
});

// ---- route guards (target is a superadmin) ----
test('PATCH /admin/users/:id cannot change a superadmin role -> 403', async () => {
  const res = await auth(request(app).patch('/admin/users/sa-1')).send({ role: 'admin' });
  expect(res.status).toBe(403);
  expect(res.body.error).toMatch(/superadmin role is immutable/i);
});

test('PATCH /admin/users/:id/status cannot deactivate the superadmin -> 403', async () => {
  const res = await auth(request(app).patch('/admin/users/sa-1/status')).send({ status: 'deactivated' });
  expect(res.status).toBe(403);
  expect(res.body.error).toMatch(/status is locked/i);
});

test('PATCH /admin/users/:id may still edit a superadmin profile field (name) -> not blocked', async () => {
  // role/status guards must NOT block a benign profile edit
  const res = await auth(request(app).patch('/admin/users/sa-1')).send({ full_name_en: 'New Name' });
  expect(res.status).toBe(200);
});

test('PATCH /admin/slots/superadmin is locked', async () => {
  const res = await auth(request(app).patch('/admin/slots/superadmin')).send({ capacity: 2 });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/locked at 1/i);
});
