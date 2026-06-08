// Superadmin AI-usage endpoints: per-user limit override (schema), standard-limit get/patch, reset.
let mockSetting = { data: { value: 0.5 }, error: null };
// One row satisfies both verifyJwt (role=superadmin) and reset-usage (returns usage_cost_usd:0).
const mockProf = { data: { id: 'sa-1', role: 'superadmin', status: 'active', usage_cost_usd: 0 }, error: null };
const mockUser = { data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null };

jest.mock('../src/lib/supabase', () => {
  const settingChain = {
    select: () => settingChain, eq: () => settingChain, upsert: () => settingChain,
    single: () => Promise.resolve(mockSetting),
  };
  const profChain = (val) => {
    const c = { select: () => c, eq: () => c, update: () => c, order: () => Promise.resolve({ data: [], error: null }), single: () => Promise.resolve(val) };
    return c;
  };
  return {
    supabase: {
      from: (table) => table === 'app_settings' ? settingChain : profChain(mockProf),
      rpc: () => Promise.resolve({ error: null }),
    },
    authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
  };
});

const request = require('supertest');
const express = require('express');
const superadminRouter = require('../src/routes/superadmin');
const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
const auth = r => r.set('Authorization', 'Bearer test');

// verifyJwt reads professionals; the mock above returns a non-superadmin row for non-app_settings
// tables, so override the auth lookup is unnecessary — guard only checks req.user.role via the row.
// (superadmin-guard.test.js covers role immutability; here we exercise the usage endpoints.)

const { UpdateUserSchema } = superadminRouter;

test('UpdateUserSchema accepts a numeric usage_limit_usd', () => {
  expect(UpdateUserSchema.safeParse({ usage_limit_usd: 0.75 }).success).toBe(true);
});
test('UpdateUserSchema accepts null usage_limit_usd (clears the override)', () => {
  expect(UpdateUserSchema.safeParse({ usage_limit_usd: null }).success).toBe(true);
});
test('UpdateUserSchema rejects a negative usage_limit_usd', () => {
  expect(UpdateUserSchema.safeParse({ usage_limit_usd: -1 }).success).toBe(false);
});

test('GET /admin/usage-settings returns the standard limit', async () => {
  const res = await auth(request(app).get('/admin/usage-settings'));
  expect(res.status).toBe(200);
  expect(res.body.standard_limit_usd).toBe(0.5);
});

test('PATCH /admin/usage-settings updates the standard limit', async () => {
  mockSetting = { data: { value: 0.75 }, error: null };
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ standard_limit_usd: 0.75 });
  expect(res.status).toBe(200);
  expect(res.body.standard_limit_usd).toBe(0.75);
});

test('PATCH /admin/usage-settings rejects a negative value', async () => {
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ standard_limit_usd: -5 });
  expect(res.status).toBe(400);
});

test('POST /admin/users/:id/reset-usage zeroes the meter', async () => {
  const res = await auth(request(app).post('/admin/users/doc9/reset-usage')).send({});
  expect(res.status).toBe(200);
  expect(res.body.usage_cost_usd).toBe(0);
});
