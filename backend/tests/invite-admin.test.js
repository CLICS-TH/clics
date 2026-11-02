// Admin-role invites (2026-06-11): the SUPERADMIN may issue an invite with role 'admin'
// (council director). Contract under test:
//   - POST /admin/invites {role:'admin'} by superadmin → 201, invites insert with role 'admin'
//     and can_audit FORCED false (can_audit is physician-only)
//   - POST /admin/invites {role:'admin'} by an ADMIN → 403 'Superadmin only.' and NO insert
//     (an admin must never mint another admin — mirrors the auditor-request approve guard)
//   - accept path (auth.js finalize → provisionProfessional): an admin invite provisions an
//     ACTIVE role-'admin' professional carrying the invite's council_id, with NO pseudonym
//     (P-NNN is physician-only) and NO slot error (admins use the per-council council_slots
//     pool, same as superadmin-created admins)
//
// Supabase mock follows invite-special.test.js (table-aware; ALL mutable state inside the
// hoisted jest.mock factory, re-exported as `__mock`). SMTP env is cleared so the mailer
// stays disabled — mail delivery is invite-email.test.js's contract.

const COUNCIL_ID = '11111111-1111-1111-1111-111111111111';

jest.mock('../src/lib/supabase', () => {
  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    caller: null,                   // professionals .single() → verifyJwt row (/admin routes)
    invite: null,                   // invites .maybeSingle() → the accept path's pending invite
    inviteClaim: [{ id: 'inv-1' }], // atomic invite-consume result (.select('id'))
    lastProfInsert: null,           // captured professionals insert payload (provisioning)
    lastInviteInsert: null,         // captured invites insert payload (POST /admin/invites)
  };
  const auth = {
    verifyOtp: () => Promise.resolve({ data: null, error: { message: 'not set' } }),
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const self = { _op: 'select', _insert: undefined };
    for (const fn of ['select', 'eq', 'neq', 'order', 'not', 'is', 'range', 'limit', 'gte', 'lte', 'in', 'or']) self[fn] = () => self;
    self.insert = (payload) => {
      self._op = 'insert'; self._insert = payload;
      if (table === 'professionals') state.lastProfInsert = payload;
      if (table === 'invites') state.lastInviteInsert = payload;
      return self;
    };
    self.update = (payload) => { self._op = 'update'; self._update = payload; return self; };
    self.delete = () => { self._op = 'delete'; return self; };

    self.maybeSingle = () => {
      if (table === 'councils') return ok({ id: state.invite?.council_id ?? null, active: true, name_th: 'แพทยสภา', name_en: 'The Medical Council' });
      if (table === 'invites') return ok(state.invite);
      if (table === 'council_slots') return ok({ capacity: 100 });
      return ok(null);
    };
    self.single = () => {
      if (self._op === 'insert' && table === 'professionals') return ok({ ...self._insert }); // echo provisioned row
      if (self._op === 'insert' && table === 'invites') {
        return ok({ id: 'inv-9', created_at: '2026-06-11T00:00:00.000Z', ...self._insert });  // echo created invite
      }
      if (table === 'professionals') return ok(state.caller);
      return ok(null);
    };
    // Thenable terminals (awaited directly): the atomic invite-claim ends in .select('id').
    self.then = (resolve, reject) => {
      let value;
      if (self._op === 'update' && table === 'invites') value = { data: state.inviteClaim, error: null };
      else if (self._op === 'insert' || self._op === 'update') value = { data: null, error: null };
      else value = { data: [], error: null };
      return Promise.resolve(value).then(resolve, reject);
    };
    return self;
  }

  const mod = {
    supabase: {
      from: builder,
      rpc: (name) => (name === 'next_pseudonym' ? Promise.resolve({ data: 'P-001', error: null }) : Promise.resolve({ data: null, error: null })),
      auth: { admin: { createUser: () => Promise.resolve({ data: { user: { id: 'x' } }, error: null }), updateUserById: () => Promise.resolve({ data: null, error: null }), deleteUser: () => Promise.resolve({}) }, signOut: () => Promise.resolve({}) },
    },
    authAnon: { auth: {
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: (...a) => auth.verifyOtp(...a),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    } },
    authSupabase: { auth: {
      signInWithPassword: () => Promise.resolve({ data: { session: { access_token: 'signed-in' } }, error: null }),
      getUser: () => Promise.resolve(
        state.caller
          ? { data: { user: { id: state.caller.id, email: 'caller@test.local' } }, error: null }
          : { data: { user: null }, error: { message: 'no caller set' } }
      ),
    } },
  };

  mod.__mock = {
    state, auth,
    reset() {
      state.caller = null;
      state.invite = null;
      state.inviteClaim = [{ id: 'inv-1' }];
      state.lastProfInsert = null;
      state.lastInviteInsert = null;
      auth.verifyOtp = () => Promise.resolve({ data: null, error: { message: 'not set' } });
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
const auth = (r) => r.set('Authorization', 'Bearer test');

const SUPERADMIN = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null };
const ADMIN_A = { id: 'adm-1', role: 'admin', status: 'active', council_id: COUNCIL_ID };
const VALID_INVITE_TOKEN = 'invite-raw-token-admin';

// Keep the mailer disabled regardless of the shell env (it reads env at CALL time).
const MAIL_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'RESEND_API_KEY'];
const savedEnv = {};
beforeAll(() => { for (const k of MAIL_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => {
  for (const k of MAIL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => m.reset());

// A pending invite row for the accept flow, keyed by the hash of VALID_INVITE_TOKEN.
function pendingInvite(role, extra = {}) {
  return {
    id: 'inv-1', email: 'invitee@example.com', role, council_id: COUNCIL_ID, status: 'pending',
    token_hash: hashToken(VALID_INVITE_TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...extra,
  };
}

// A verifyOtp success carrying the invite_signup metadata + a session (auth-flows pattern).
function otpUser({ id, email, invite_signup }) {
  return () => Promise.resolve({
    data: {
      user: { id, email, user_metadata: invite_signup ? { invite_signup } : {} },
      session: { access_token: 'sess-' + id },
    },
    error: null,
  });
}

// ---------------------------------------------------------------------------
// POST /admin/invites — who may issue an admin invite
// ---------------------------------------------------------------------------

test('superadmin invites role admin → 201, invites insert role:admin with can_audit FORCED false', async () => {
  m.state.caller = SUPERADMIN;

  const r = await auth(request(app).post('/admin/invites')).send({
    email: 'director@example.com', role: 'admin', can_audit: true, council_id: COUNCIL_ID,
  });

  expect(r.status).toBe(201);
  expect(m.state.lastInviteInsert).toMatchObject({
    email: 'director@example.com', role: 'admin', can_audit: false, council_id: COUNCIL_ID, status: 'pending',
  });
  expect(r.body.role).toBe('admin');
  expect(r.body.accept_url).toMatch(/\/invite\.html\?token=/); // normal invite plumbing intact
});

test('an ADMIN inviting role admin → 403 Superadmin only, NO invite row created', async () => {
  m.state.caller = ADMIN_A;

  const r = await auth(request(app).post('/admin/invites')).send({
    email: 'director@example.com', role: 'admin', council_id: COUNCIL_ID, // even their OWN council
  });

  expect(r.status).toBe(403);
  expect(r.body).toEqual({ error: 'Superadmin only.' });
  expect(m.state.lastInviteInsert).toBeNull(); // guard fired before any DB write
});

test('control: an ADMIN can still invite a physician into their own council (201)', async () => {
  m.state.caller = ADMIN_A;

  const r = await auth(request(app).post('/admin/invites')).send({
    email: 'doc@example.com', role: 'physician', council_id: COUNCIL_ID,
  });

  expect(r.status).toBe(201);
  expect(m.state.lastInviteInsert).toMatchObject({ role: 'physician', council_id: COUNCIL_ID });
});

// ---------------------------------------------------------------------------
// POST /auth/invite/:token/accept — an admin invite provisions a council admin
// ---------------------------------------------------------------------------

test('accepting an admin invite → ACTIVE role-admin professional with council_id, NO pseudonym, NO slot error', async () => {
  m.state.invite = pendingInvite('admin');
  m.auth.verifyOtp = otpUser({
    id: 'adm-new', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'ผู้ดูแลใหม่', full_name_en: 'New Director' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'ผู้ดูแลใหม่', full_name_en: 'New Director',
  });

  expect(r.status).toBe(201);                 // no 409 slot_full — the council admin pool admits them
  expect(r.body.status).toBe('active');
  expect(m.state.lastProfInsert).toMatchObject({
    id: 'adm-new', role: 'admin', status: 'active', council_id: COUNCIL_ID,
  });
  expect(m.state.lastProfInsert.pseudonym).toBeUndefined(); // P-NNN series is physician-only
  expect(m.state.lastProfInsert.can_audit).toBeUndefined(); // no Special flag leaks onto admins
  expect(r.body.user).toMatchObject({ role: 'admin', council_id: COUNCIL_ID });
});
