// New-auth integration tests for the Google + invite onboarding model (License No. + TMC retired
// 2026-06-09). The A/B invite IS the vetting: BOTH physicians and auditors are provisioned ACTIVE
// immediately on accept — no license gate, no pending_license_review, no license columns written.
// Public email-OTP self-signup was removed (signup-auth.test.js covers the 404).
//
// Only the edges are mocked: the two Supabase auth clients (OTP verify / token decode) and the
// Supabase data layer. The supabase mock is table-aware. Because a jest.mock() factory is hoisted
// and may not close over normal outer variables, ALL mutable mock state lives inside the factory
// and is re-exported as `__mock` (a `mock`-prefixed name is the one exception jest allows). Tests
// grab it via require and steer each table read through `m.state.*`; the `professionals` insert
// payload is captured into `m.state.lastInsert` so we can assert the provisioned row shape (and
// that the dormant license_* columns are NOT written).

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
      auth: { admin: { createUser: () => Promise.resolve({ data: { user: { id: 'x' } }, error: null }), updateUserById: () => Promise.resolve({ data: null, error: null }), deleteUser: () => Promise.resolve({}) }, signOut: () => Promise.resolve({}) },
    },
    authAnon: { auth: {
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: (...a) => auth.verifyOtp(...a),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    } },
    authSupabase: { auth: {
      getUser: (...a) => auth.getUser(...a),
      signInWithPassword: () => Promise.resolve({ data: { session: { access_token: 'signed-in' } }, error: null }),
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
// 1) Invite accept (password method) — the A/B invite IS the vetting; NO license gate.
//    BOTH physicians and auditors are provisioned ACTIVE immediately on accept.
// ---------------------------------------------------------------------------

test('invite accept: physician invite → 201 active; dormant license columns NOT written', async () => {
  m.state.invite = pendingInvite('physician');
  m.auth.verifyOtp = otpUser({
    id: 'phys-inv', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'หมอ', full_name_en: 'Doc' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'หมอ', full_name_en: 'Doc',
  });

  expect(r.status).toBe(201);
  expect(r.body.status).toBe('active');
  expect(r.body.license_status).toBeUndefined();            // license no longer in the response
  expect(m.state.lastInsert).toMatchObject({ id: 'phys-inv', role: 'physician', status: 'active' });
  expect(m.state.lastInsert.license_status).toBeUndefined(); // dormant column unwritten
  expect(m.state.lastInsert.license_number).toBeUndefined();
});

test('invite accept: AUDITOR invite → 201 ACTIVE on accept (was 202 pending under the old gate)', async () => {
  m.state.invite = pendingInvite('auditor');
  m.auth.verifyOtp = otpUser({
    id: 'aud-inv', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor',
  });

  expect(r.status).toBe(201);
  expect(r.body.status).toBe('active');
  expect(m.state.lastInsert).toMatchObject({ id: 'aud-inv', role: 'auditor', status: 'active' });
});

test('invite accept: auditor invite no longer demands a license_number (step 1 → otp_sent)', async () => {
  m.state.invite = pendingInvite('auditor');
  // step 1 (no otp): name + password only. Old code 400'd here for a missing auditor license.
  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', password: 'longenough1', full_name_th: 'ผู้ตรวจ', full_name_en: 'Auditor',
  });
  expect(r.status).toBe(202);
  expect(r.body.status).toBe('otp_sent');
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
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340',
  });

  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/already been used/i);
});

test('invite accept: an invite whose row is no longer pending → 404 (idempotent reject)', async () => {
  m.state.invite = { ...pendingInvite('physician'), status: 'accepted' };
  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'หมอ', full_name_en: 'Doc', license_number: '12340',
  });
  expect(r.status).toBe(404);
});
