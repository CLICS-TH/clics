// Superadmin AI-usage endpoints: per-user limit override (schema), standard-limit get/patch, reset.
let mockSetting = { data: { value: 0.5 }, error: null };
// One row satisfies both verifyJwt (role=superadmin) and reset-usage (returns usage_cost_usd:0).
const mockProf = { data: { id: 'sa-1', role: 'superadmin', status: 'active', usage_cost_usd: 0 }, error: null };
const mockUser = { data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null };
let mockKnownCouncils = ['SANDBOX', 'TMC'];

jest.mock('../src/lib/supabase', () => {
  const settingChain = {
    select: () => settingChain, eq: () => settingChain, upsert: () => settingChain,
    single: () => Promise.resolve(mockSetting),
  };
  const profChain = (val) => {
    const c = { select: () => c, eq: () => c, update: () => c, order: () => Promise.resolve({ data: [], error: null }), single: () => Promise.resolve(val), maybeSingle: () => Promise.resolve(val) };
    return c;
  };
  const councilsChain = {
    select: () => councilsChain,
    in: (_col, vals) => Promise.resolve({ data: vals.filter((v) => mockKnownCouncils.includes(v)).map((code) => ({ code })), error: null }),
  };
  return {
    supabase: {
      from: (table) => table === 'app_settings' ? settingChain : table === 'councils' ? councilsChain : profChain(mockProf),
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

test('GET /admin/usage-settings returns standard limit, API pool, and total used', async () => {
  const res = await auth(request(app).get('/admin/usage-settings'));
  expect(res.status).toBe(200);
  expect(res.body.standard_limit_usd).toBe(0.5);
  expect(res.body).toHaveProperty('api_budget_pool_usd');
  expect(res.body).toHaveProperty('total_used_usd');
});

test('PATCH /admin/usage-settings updates the standard limit', async () => {
  mockSetting = { data: { value: 0.75 }, error: null };
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ standard_limit_usd: 0.75 });
  expect(res.status).toBe(200);
  expect(res.body.standard_limit_usd).toBe(0.75);
});

test('PATCH /admin/usage-settings updates the API budget pool', async () => {
  mockSetting = { data: { value: 50 }, error: null };
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ api_budget_pool_usd: 50 });
  expect(res.status).toBe(200);
  expect(res.body.api_budget_pool_usd).toBe(50);
});

test('PATCH /admin/usage-settings rejects a negative value', async () => {
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ standard_limit_usd: -5 });
  expect(res.status).toBe(400);
});

test('PATCH /admin/usage-settings rejects an empty body', async () => {
  const res = await auth(request(app).patch('/admin/usage-settings')).send({});
  expect(res.status).toBe(400);
});

test('POST /admin/users/:id/reset-usage zeroes the meter', async () => {
  const res = await auth(request(app).post('/admin/users/doc9/reset-usage')).send({});
  expect(res.status).toBe(200);
  expect(res.body.usage_cost_usd).toBe(0);
});

// eval_drain_exclude_councils is the prod↔laptop evaluation partition. lib/eval-scope.js fails CLOSED on a
// code that names no council, so the PATCH must refuse a typo instead of saving something that silently
// stops every evaluation.
test('PATCH /admin/usage-settings refuses an unknown council code in eval_drain_exclude_councils (400, names it)', async () => {
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ eval_drain_exclude_councils: 'sandbox, SANDBX' });
  expect(res.status).toBe(400);
  expect(res.body.unknown).toEqual(['SANDBX']);
});
test('PATCH /admin/usage-settings accepts known council codes (normalised upper-case) and an empty string (clears)', async () => {
  expect((await auth(request(app).patch('/admin/usage-settings')).send({ eval_drain_exclude_councils: 'sandbox,tmc' })).status).toBe(200);
  expect((await auth(request(app).patch('/admin/usage-settings')).send({ eval_drain_exclude_councils: '' })).status).toBe(200);
});

test('PATCH /admin/usage-settings echoes the capacity keys too (a client may setState(response) after saving)', async () => {
  const res = await auth(request(app).patch('/admin/usage-settings')).send({ ple_transcript_warn_pct: 85 });
  expect(res.status).toBe(200);
  for (const k of ['standard_limit_tokens', 'auditor_standard_limit_tokens', 'ple_max_transcript_tokens', 'ple_transcript_warn_pct',
    'eval_drain_concurrency', 'eval_p50_seconds', 'eval_drain_exclude_councils']) expect(res.body).toHaveProperty(k);
});
