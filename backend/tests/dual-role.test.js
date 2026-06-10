// Dual-role ("Special" physician, 2026-06-10): professionals.can_audit lets a physician ALSO
// pass requireRole('auditor') while their primary role stays 'physician'. Under test here:
//   (a) the requireRole gate via the REAL auditor router: a can_audit physician reaches
//       /auditor/queue (200); a plain physician is rejected (403); a pure auditor still passes.
//   (b) GET /admin/users?status= is filtered SERVER-side: .eq('status','active'|'deactivated')
//       lands on the count:'exact' list query (so X-Total-Count respects the filter); an unknown
//       status value applies NO filter.
//   (c) POST /auth/oauth/google/complete with OAUTH_ENABLED=true: council_id is OPTIONAL — an
//       EXISTING professional gets their account back with no council_id at all, while a NEW
//       user without one gets 400 {code:'council_required'} (the UI's cue to show the picker).
//
// OAUTH_ENABLED is read ONCE at auth-router module load, so it is set before the requires below
// and restored in afterAll — signup-auth.test.js relies on it being unset for its 404 test.
//
// Only the Supabase edge is mocked (table-aware, same pattern as admin-users-scope.test.js):
// all mutable state lives INSIDE the hoisted jest.mock factory and is re-exported as `__mock`.
// The builder RECORDS every query (table, select args, eq calls) into state.queries so tests
// assert exactly which filters a route applied — not just the response shape.

const OAUTH_PREV = process.env.OAUTH_ENABLED;
process.env.OAUTH_ENABLED = 'true';

jest.mock('../src/lib/supabase', () => {
  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    caller: null,       // professionals .single() → the row verifyJwt sees for the bearer token
    profByToken: null,  // professionals .maybeSingle() → google/complete existing-account lookup
    listRows: [],       // rows the awaited list query resolves with
    listCount: 0,       // count:'exact' total the list query resolves with
    queries: [],        // every builder created: { table, op, selectArgs, eqs: [[col, val], ...] }
  };
  const auth = {
    // Default: decode the caller's bearer token. Google-complete tests override this per test
    // (there the token is the GOOGLE session token, and no verifyJwt runs on the route).
    getUser: null, // installed by reset()
  };
  const defaultGetUser = () => Promise.resolve(
    state.caller
      ? { data: { user: { id: state.caller.id, email: 'caller@test.local' } }, error: null }
      : { data: { user: null }, error: { message: 'no caller set' } }
  );
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const rec = { table, op: 'select', selectArgs: null, eqs: [], payload: undefined };
    state.queries.push(rec);
    const self = {};
    self.select = (...args) => { rec.selectArgs = args; return self; };
    self.eq = (col, val) => { rec.eqs.push([col, val]); return self; };
    self.insert = (payload) => { rec.op = 'insert'; rec.payload = payload; return self; };
    self.update = (payload) => { rec.op = 'update'; rec.payload = payload; return self; };
    for (const fn of ['order', 'range', 'limit', 'in', 'neq', 'not', 'is', 'gte', 'lte', 'or']) self[fn] = () => self;
    self.single = () => (table === 'professionals' ? ok(state.caller) : ok(null));
    self.maybeSingle = () => (table === 'professionals' ? ok(state.profByToken) : ok(null));
    // Thenable terminal: list queries are awaited directly and destructure { data, error, count }.
    self.then = (resolve, reject) => {
      const value = table === 'professionals'
        ? { data: state.listRows, error: null, count: state.listCount }
        : { data: [], error: null, count: 0 };
      return Promise.resolve(value).then(resolve, reject);
    };
    return self;
  }

  const mod = {
    supabase: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
    authSupabase: { auth: { getUser: (...a) => auth.getUser(...a) } },
    authAnon: { auth: {
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: () => Promise.resolve({ data: null, error: { message: 'not set' } }),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    } },
  };

  mod.__mock = {
    state, auth,
    reset() {
      state.caller = null;
      state.profByToken = null;
      state.listRows = [];
      state.listCount = 0;
      state.queries.length = 0;
      auth.getUser = defaultGetUser;
    },
  };
  mod.__mock.reset();
  return mod;
});

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const authRouter = require('../src/routes/auth');       // loaded with OAUTH_ENABLED=true (above)
const adminRouter = require('../src/routes/admin');
const auditorRouter = require('../src/routes/auditor');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/auditor', auditorRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => m.reset());
afterAll(() => {
  if (OAUTH_PREV === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = OAUTH_PREV;
});

const SPECIAL_PHYSICIAN = { id: 'phys-aud', role: 'physician', status: 'active', council_id: 'C1', can_audit: true };
const PLAIN_PHYSICIAN = { id: 'phys-1', role: 'physician', status: 'active', council_id: 'C1' };
const PURE_AUDITOR = { id: 'aud-1', role: 'auditor', status: 'active', council_id: 'C1' };
const SUPERADMIN = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null };

// ---------------------------------------------------------------------------
// (a) requireRole('auditor') — exercised through the real auditor router
// ---------------------------------------------------------------------------

test('physician with can_audit=true passes requireRole(auditor) → /auditor/queue 200', async () => {
  m.state.caller = SPECIAL_PHYSICIAN;
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body)).toBe(true);
});

test('plain physician (no can_audit) → 403 from requireRole(auditor)', async () => {
  m.state.caller = PLAIN_PHYSICIAN;
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/Requires role: auditor/);
});

test('pure auditor still passes the gate (dual-role change did not break the base case)', async () => {
  m.state.caller = PURE_AUDITOR;
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(200);
});

// ---------------------------------------------------------------------------
// (b) GET /admin/users?status= — server-side filter on the count:'exact' list query
// ---------------------------------------------------------------------------

// The members-list query is the professionals select carrying count:'exact'; verifyJwt's own
// professionals lookup is select('*') with no options object, so this discriminates cleanly.
const listQuery = () =>
  m.state.queries.find((q) => q.table === 'professionals' && q.selectArgs?.[1]?.count === 'exact');

test('GET /admin/users?status=active applies .eq(status, active); X-Total-Count from the filtered count', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [{ id: 'p-1', role: 'physician', status: 'active' }];
  m.state.listCount = 7;

  const r = await auth(request(app).get('/admin/users?status=active'));

  expect(r.status).toBe(200);
  expect(r.headers['x-total-count']).toBe('7');
  const q = listQuery();
  expect(q).toBeDefined();
  expect(q.eqs).toContainEqual(['status', 'active']);
});

test('GET /admin/users?status=deactivated applies .eq(status, deactivated)', async () => {
  m.state.caller = SUPERADMIN;
  const r = await auth(request(app).get('/admin/users?status=deactivated'));
  expect(r.status).toBe(200);
  expect(listQuery().eqs).toContainEqual(['status', 'deactivated']);
});

test('GET /admin/users with an unknown status value applies NO status filter', async () => {
  m.state.caller = SUPERADMIN;
  const r = await auth(request(app).get('/admin/users?status=banana'));
  expect(r.status).toBe(200);
  expect(listQuery().eqs.map(([col]) => col)).not.toContain('status');
});

// ---------------------------------------------------------------------------
// (c) POST /auth/oauth/google/complete with OAUTH_ENABLED=true — council_id is OPTIONAL
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN = 'g'.repeat(24);
const googleUser = (id, email) => () =>
  Promise.resolve({ data: { user: { id, email, user_metadata: {} } }, error: null });

test('google/complete: EXISTING professional, NO council_id → 200 with their account', async () => {
  m.auth.getUser = googleUser('g-1', 'g@example.com');
  m.state.profByToken = { id: 'g-1', role: 'physician', status: 'active', council_id: 'C1', can_audit: false };

  const r = await request(app).post('/auth/oauth/google/complete').send({ access_token: GOOGLE_TOKEN });

  expect(r.status).toBe(200);
  expect(r.body.access_token).toBe(GOOGLE_TOKEN);
  expect(r.body.user).toMatchObject({ id: 'g-1', role: 'physician', can_audit: false });
});

test('google/complete: NEW user (no professionals row) without council_id → 400 council_required', async () => {
  m.auth.getUser = googleUser('g-new', 'new@example.com');
  m.state.profByToken = null;

  const r = await request(app).post('/auth/oauth/google/complete').send({ access_token: GOOGLE_TOKEN });

  expect(r.status).toBe(400);
  expect(r.body.code).toBe('council_required');
});
