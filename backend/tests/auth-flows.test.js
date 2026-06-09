// New-auth integration tests: the two self-service / invited entry paths and the manual
// license override. The point of these tests is to pin the LICENSE GATE behaviour end-to-end
// through the real (deterministic) stub verifier + provisioning layer:
//
//   physician = SOFT gate  → always provisioned 'active'; license_status just mirrors the result.
//   auditor   = HARD gate  → 'active' only if verified/manual_verified, else 'deactivated' +
//                            HTTP 202 pending_license_review.
//
// Only the edges are mocked: the two Supabase auth clients (OTP verify / token decode) and the
// Supabase data layer. The license verifier itself is the REAL stub adapter (pure, keyed off the
// license digit per the contract), so these assertions exercise the genuine mapping:
//   ...0/2/4/6/8 → verified ; ...1/3 → name_mismatch ; ...5/7/9 → not_found ; 'UNAVAIL' → unavailable
//   toLicenseStatus: verified→verified, name_mismatch→name_mismatch, not_found→not_found, unavailable→unverified.
//
// The supabase mock is table-aware. Because a jest.mock() factory is hoisted and may not close
// over normal outer variables, ALL mutable mock state lives inside the factory and is re-exported
// as `__mock` (a `mock`-prefixed name is the one exception jest allows). Tests grab it via require
// and steer each table read through `m.state.*`; the `professionals` insert payload is captured
// into `m.state.lastInsert` so we can assert the provisioned row shape.

const COUNCIL_ID = '11111111-1111-1111-1111-111111111111';

jest.mock('../src/lib/supabase', () => {
  const COUNCIL = '11111111-1111-1111-1111-111111111111';

  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    councilActive: true,         // councils lookup → active?
    existingProfessional: null,  // default professionals .maybeSingle()/.single()
    singleQueue: null,           // optional ORDERED queue of professionals .single() results (FIFO)
    invite: null,                // invites .maybeSingle()
    inviteClaim: [{ id: 'inv-1' }], // atomic invite-consume result (.select('id'))
    lastInsert: null,            // captured professionals insert payload
  };
  const auth = {
    verifyOtp: () => Promise.resolve({ data: null, error: { message: 'not set' } }),
    getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'not set' } }),
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const self = { _op: 'select', _insert: undefined };
    for (const m of ['select', 'eq', 'neq', 'order', 'not', 'is', 'range', 'limit', 'gte', 'lte', 'in']) self[m] = () => self;
    self.insert = (payload) => { self._op = 'insert'; self._insert = payload; if (table === 'professionals') state.lastInsert = payload; return self; };
    self.update = (payload) => { self._op = 'update'; self._update = payload; return self; };
    self.delete = () => { self._op = 'delete'; return self; };

    self.maybeSingle = () => {
      if (table === 'councils') return ok(state.councilActive ? { id: COUNCIL, active: true } : null);
      if (table === 'professionals') return ok(state.existingProfessional);
      if (table === 'invites') return ok(state.invite);
      if (table === 'council_slots') return ok({ capacity: 100 });
      return ok(null);
    };
    self.single = () => {
      if (self._op === 'insert' && table === 'professionals') return ok({ ...self._insert }); // echo inserted row
      if (table === 'professionals') {
        if (Array.isArray(state.singleQueue) && state.singleQueue.length) return ok(state.singleQueue.shift());
        return ok(state.existingProfessional);
      }
      if (table === 'councils') return ok(state.councilActive ? { id: COUNCIL, active: true } : null);
      return ok(null);
    };
    // Thenable terminals (awaited directly): the atomic invite-claim ends in .select('id').
    self.then = (resolve, reject) => {
      let value;
      if (self._op === 'update' && table === 'invites') value = { data: state.inviteClaim, error: null };
      else if (self._op === 'insert') value = { data: null, error: null };
      else if (self._op === 'update') value = { data: null, error: null };
      else value = { data: [], error: null };
      return Promise.resolve(value).then(resolve, reject);
    };
    return self;
  }

  const mod = {
    supabase: {
      from: (table) => builder(table),
      rpc: (name) => (name === 'next_pseudonym' ? Promise.resolve({ data: 'P-001', error: null }) : Promise.resolve({ data: null, error: null })),
      auth: { admin: { createUser: () => Promise.resolve({ data: { user: { id: 'x' } }, error: null }), deleteUser: () => Promise.resolve({}) }, signOut: () => Promise.resolve({}) },
    },
    authAnon: { auth: {
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: (...a) => auth.verifyOtp(...a),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    } },
    authSupabase: { auth: {
      getUser: (...a) => auth.getUser(...a),
      signInWithPassword: () => Promise.resolve({ data: null, error: { message: 'no' } }),
    } },
  };

  mod.__mock = {
    state, auth,
    reset() {
      state.councilActive = true;
      state.existingProfessional = null;
      state.singleQueue = null;
      state.invite = null;
      state.inviteClaim = [{ id: 'inv-1' }];
      state.lastInsert = null;
      auth.verifyOtp = () => Promise.resolve({ data: null, error: { message: 'not set' } });
      auth.getUser = () => Promise.resolve({ data: { user: null }, error: { message: 'not set' } });
    },
  };
  return mod;
});

const request = require('supertest');
const express = require('express');
const { hashToken } = require('../src/lib/invite-token');
const { __mock: m } = require('../src/lib/supabase');

const authRouter = require('../src/routes/auth');
const adminRouter = require('../src/routes/admin');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/admin', adminRouter);

const VALID_INVITE_TOKEN = 'invite-raw-token-abc';

beforeEach(() => m.reset());

// A pending invite row for the password-accept flow, keyed by the hash of VALID_INVITE_TOKEN.
function pendingInvite(role) {
  return {
    id: 'inv-1', email: 'invitee@example.com', role, council_id: COUNCIL_ID, status: 'pending',
    token_hash: hashToken(VALID_INVITE_TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
}

// A verifyOtp success carrying the pending signup / invite_signup metadata + a session.
function otpUser({ id, email, signup, invite_signup }) {
  return () => Promise.resolve({
    data: {
      user: { id, email, user_metadata: { ...(signup ? { signup } : {}), ...(invite_signup ? { invite_signup } : {}) } },
      session: { access_token: 'sess-' + id },
    },
    error: null,
  });
}

// ---------------------------------------------------------------------------
// 1) Self-service signup: verify-otp → license check → auto-provision physician (SOFT gate)
// ---------------------------------------------------------------------------

test('signup verify-otp: valid OTP + verified license → physician active, license_status=verified', async () => {
  m.auth.verifyOtp = otpUser({
    id: 'phys-verified', email: 'a@example.com',
    signup: { council_id: COUNCIL_ID, full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340', specialty: null },
  });

  const r = await request(app).post('/auth/signup/verify-otp').send({ email: 'a@example.com', token: '123456' });

  expect(r.status).toBe(201);
  expect(r.body.license_status).toBe('verified');
  expect(m.state.lastInsert).toMatchObject({
    id: 'phys-verified', role: 'physician', status: 'active',
    license_status: 'verified', council_id: COUNCIL_ID, license_number: '12340',
  });
  expect(m.state.lastInsert.pseudonym).toBe('P-001');           // physicians get a pseudonym
  expect(m.state.lastInsert.license_verified_at).toBeTruthy();   // set when verified
  expect(r.body.user).toMatchObject({ id: 'phys-verified', role: 'physician', status: 'active' });
});

test('signup verify-otp: valid OTP + UNAVAIL license → physician STILL active, license_status=unverified (soft)', async () => {
  m.auth.verifyOtp = otpUser({
    id: 'phys-unavail', email: 'b@example.com',
    signup: { council_id: COUNCIL_ID, full_name_th: 'หมอ', full_name_en: 'Doc', license_number: 'UNAVAIL', specialty: null },
  });

  const r = await request(app).post('/auth/signup/verify-otp').send({ email: 'b@example.com', token: '123456' });

  expect(r.status).toBe(201);
  expect(r.body.license_status).toBe('unverified'); // unavailable → unverified, still provisioned
  expect(m.state.lastInsert).toMatchObject({ id: 'phys-unavail', role: 'physician', status: 'active', license_status: 'unverified' });
  expect(m.state.lastInsert.license_verified_at).toBeUndefined(); // NOT set when not verified
});

test('signup verify-otp: INVALID OTP → 400 and NO provisioning', async () => {
  m.auth.verifyOtp = () => Promise.resolve({ data: null, error: { message: 'invalid' } });

  const r = await request(app).post('/auth/signup/verify-otp').send({ email: 'c@example.com', token: '000000' });

  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/invalid or expired/i);
  expect(m.state.lastInsert).toBeNull(); // nothing provisioned
});

// ---------------------------------------------------------------------------
// 2) Invite accept (password method, step 2 with mocked OTP) — the license gate matrix
// ---------------------------------------------------------------------------

test('invite accept: physician invite with a NAME_MISMATCH license → active (soft gate)', async () => {
  m.state.invite = pendingInvite('physician');
  m.auth.verifyOtp = otpUser({
    id: 'phys-inv', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '13' }, // ...3 → name_mismatch
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '13',
  });

  expect(r.status).toBe(201);
  expect(r.body.status).toBe('active');
  expect(r.body.license_status).toBe('name_mismatch');
  expect(m.state.lastInsert).toMatchObject({ id: 'phys-inv', role: 'physician', status: 'active', license_status: 'name_mismatch' });
});

test('invite accept: auditor invite with a NON-verified license → 202 pending_license_review, status NOT active', async () => {
  m.state.invite = pendingInvite('auditor');
  m.auth.verifyOtp = otpUser({
    id: 'aud-pending', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor', license_number: '15' }, // ...5 → not_found
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor', license_number: '15',
  });

  expect(r.status).toBe(202);
  expect(r.body.status).toBe('pending_license_review');
  expect(r.body.license_status).toBe('not_found');
  expect(m.state.lastInsert).toMatchObject({ id: 'aud-pending', role: 'auditor', license_status: 'not_found' });
  expect(m.state.lastInsert.status).toBe('deactivated'); // HARD gate → not active
});

test('invite accept: auditor invite with a VERIFIED license → 201 active', async () => {
  m.state.invite = pendingInvite('auditor');
  m.auth.verifyOtp = otpUser({
    id: 'aud-active', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor', license_number: '246' }, // ...6 → verified
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor', license_number: '246',
  });

  expect(r.status).toBe(201);
  expect(r.body.status).toBe('active');
  expect(r.body.license_status).toBe('verified');
  expect(m.state.lastInsert).toMatchObject({ id: 'aud-active', role: 'auditor', status: 'active', license_status: 'verified' });
  expect(m.state.lastInsert.license_verified_at).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 3) Invite accept idempotency — an already-consumed invite can't be re-accepted
// ---------------------------------------------------------------------------

test('invite accept: re-accepting an already-claimed invite → 409', async () => {
  m.state.invite = pendingInvite('physician');
  // The invite row still reads pending (loadPendingInvite passes), but the ATOMIC consume claims
  // ZERO rows because an earlier/concurrent accept already took it ⇒ 409.
  m.state.inviteClaim = [];
  m.auth.verifyOtp = otpUser({
    id: 'phys-dupe', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340',
  });

  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/already been used/i);
});

test('invite accept: an invite whose row is no longer pending → 404 (idempotent reject)', async () => {
  m.state.invite = { ...pendingInvite('physician'), status: 'accepted' };
  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340',
  });
  expect(r.status).toBe(404);
});

// ---------------------------------------------------------------------------
// 4) POST /admin/users/:id/verify-license — manual override → manual_verified
// ---------------------------------------------------------------------------

test('POST /admin/users/:id/verify-license: pending auditor → manual_verified + activated, returns updated row', async () => {
  // verifyJwt decodes the Bearer to an active superadmin (superadmin skips council scoping).
  m.auth.getUser = () => Promise.resolve({ data: { user: { id: 'admin-1', email: 'admin@clics.th' } }, error: null });

  const target = { id: 'aud-target', role: 'auditor', status: 'deactivated', council_id: COUNCIL_ID, license_number: '15', full_name_th: 'ผู้ตรวจ' };
  const updated = { ...target, license_status: 'manual_verified', status: 'active', license_verified_at: new Date().toISOString() };

  // professionals .single() is read three times in order:
  //   1) verifyJwt → the SUPERADMIN caller
  //   2) the route's target read  → the pending auditor
  //   3) the UPDATE ... .select('*').single() → the updated row the route returns
  m.state.singleQueue = [
    { id: 'admin-1', role: 'superadmin', status: 'active' },
    target,
    updated,
  ];

  const r = await request(app).post('/admin/users/aud-target/verify-license').set('Authorization', 'Bearer admin-token').send({});

  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ id: 'aud-target', license_status: 'manual_verified', status: 'active' });
  expect(r.body.license_verified_at).toBeTruthy();
});
