// Auditor-rights requests (the "special" dual role, 2026-06-10). A physician asks to ALSO audit
// via POST /auth/request-auditor — the request lives in access_requests (requested_role='auditor',
// provider='role_request'); an admin/superadmin approves via POST /admin/auditor-requests/:id/approve,
// which flips professionals.can_audit=true and marks the request approved. Under test:
//   - physician without can_audit → 202 {status:'pending'} + the access_requests insert payload
//   - physician WITH can_audit    → 409 {code:'already_auditor'} (and NO insert)
//   - duplicate pending request   → 409 {code:'pending'} (and NO insert)
//   - non-physician caller        → 403 (the dual role only extends physicians)
//   - approve (superadmin)        → professionals update {can_audit:true} captured + request marked approved
//   - already-processed request   → 409 (and the professional is NOT touched)
//
// Only the Supabase edge is mocked (table-aware recording mock, same pattern as
// admin-users-scope.test.js): state lives INSIDE the hoisted jest.mock factory, re-exported as
// `__mock`; the builder records every query so tests assert payloads AND the .eq() targeting.

jest.mock('../src/lib/supabase', () => {
  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    caller: null,      // professionals .single() → the row verifyJwt sees for the bearer token
    dupPending: null,  // access_requests .maybeSingle() → the duplicate-pending check
    requestRow: null,  // access_requests .single() → the approve route's lookup
    queries: [],       // every builder created: { table, op, selectArgs, eqs, payload }
  };
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
    self.single = () => {
      if (table === 'professionals') return ok(state.caller);
      if (table === 'access_requests') return ok(state.requestRow);
      return ok(null);
    };
    self.maybeSingle = () => (table === 'access_requests' ? ok(state.dupPending) : ok(null));
    // Thenable terminal: the insert and the two updates are awaited directly.
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
    authAnon: { auth: {
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: () => Promise.resolve({ data: null, error: { message: 'not set' } }),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    } },
  };

  mod.__mock = {
    state,
    reset() {
      state.caller = null;
      state.dupPending = null;
      state.requestRow = null;
      state.queries.length = 0;
    },
  };
  return mod;
});

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const authRouter = require('../src/routes/auth');
const adminRouter = require('../src/routes/admin');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => m.reset());

const PHYSICIAN = {
  id: 'phys-1', role: 'physician', status: 'active', council_id: 'C1',
  full_name_th: 'หมอ', full_name_en: 'Doc', specialty: null,
};
const SPECIAL_PHYSICIAN = { ...PHYSICIAN, can_audit: true };
const AUDITOR = { id: 'aud-1', role: 'auditor', status: 'active', council_id: 'C1' };
const SUPERADMIN = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null };

const findInsert = (table) => m.state.queries.find((q) => q.table === table && q.op === 'insert');
const findUpdate = (table) => m.state.queries.find((q) => q.table === table && q.op === 'update');

// ---------------------------------------------------------------------------
// POST /auth/request-auditor
// ---------------------------------------------------------------------------

test('physician without can_audit → 202 pending; access_requests insert carries the role-request shape', async () => {
  m.state.caller = PHYSICIAN;

  const r = await auth(request(app).post('/auth/request-auditor'));

  expect(r.status).toBe(202);
  expect(r.body).toEqual({ status: 'pending' });

  const ins = findInsert('access_requests');
  expect(ins).toBeDefined();
  expect(ins.payload).toMatchObject({
    requested_role: 'auditor',
    provider: 'role_request',
    status: 'pending',
    auth_user_id: 'phys-1',
    email: 'caller@test.local',     // from the VALIDATED token, not the request body
    council_id: 'C1',
    full_name_th: 'หมอ',
    full_name_en: 'Doc',
  });
});

test('physician who ALREADY has can_audit → 409 already_auditor, nothing inserted', async () => {
  m.state.caller = SPECIAL_PHYSICIAN;

  const r = await auth(request(app).post('/auth/request-auditor'));

  expect(r.status).toBe(409);
  expect(r.body.code).toBe('already_auditor');
  expect(findInsert('access_requests')).toBeUndefined();
});

test('duplicate pending request → 409 pending, nothing inserted', async () => {
  m.state.caller = PHYSICIAN;
  m.state.dupPending = { id: 'req-existing' };   // the dup check finds a pending auditor request

  const r = await auth(request(app).post('/auth/request-auditor'));

  expect(r.status).toBe(409);
  expect(r.body.code).toBe('pending');
  expect(findInsert('access_requests')).toBeUndefined();
});

test('non-physician caller (an auditor) → 403', async () => {
  m.state.caller = AUDITOR;

  const r = await auth(request(app).post('/auth/request-auditor'));

  expect(r.status).toBe(403);
  expect(findInsert('access_requests')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// POST /admin/auditor-requests/:id/approve
// ---------------------------------------------------------------------------

const PENDING_REQUEST = {
  id: 'req-1', requested_role: 'auditor', provider: 'role_request', status: 'pending',
  council_id: 'C1', auth_user_id: 'phys-1',
};

test('approve (superadmin) → professionals {can_audit:true} on the requester + request marked approved', async () => {
  m.state.caller = SUPERADMIN;
  m.state.requestRow = PENDING_REQUEST;

  const r = await auth(request(app).post('/admin/auditor-requests/req-1/approve'));

  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, professional_id: 'phys-1', can_audit: true });

  // The grant lands on the REQUESTER's professionals row.
  const grant = findUpdate('professionals');
  expect(grant).toBeDefined();
  expect(grant.payload).toEqual({ can_audit: true });
  expect(grant.eqs).toContainEqual(['id', 'phys-1']);

  // And the request itself is closed out with the reviewer stamped.
  const closed = findUpdate('access_requests');
  expect(closed).toBeDefined();
  expect(closed.payload).toMatchObject({ status: 'approved', reviewed_by: 'sa-1' });
  expect(closed.payload.reviewed_at).toEqual(expect.any(String));
  expect(closed.eqs).toContainEqual(['id', 'req-1']);
});

test('approve an already-processed request → 409 and the professional is NOT touched', async () => {
  m.state.caller = SUPERADMIN;
  m.state.requestRow = { ...PENDING_REQUEST, status: 'approved' };

  const r = await auth(request(app).post('/admin/auditor-requests/req-1/approve'));

  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/already processed/i);
  expect(findUpdate('professionals')).toBeUndefined();
  expect(findUpdate('access_requests')).toBeUndefined();
});
