// "Special" invites (dual role, 2026-06-10): an A/B invite may carry can_audit=true so the
// invited PHYSICIAN also gets auditor rights on accept. invite-email.test.js owns the mail
// fail-soft contract — this file covers the can_audit plumbing end to end:
//   - POST /admin/invites {role:'physician', can_audit:true} → invites insert with can_audit:true
//   - POST /admin/invites {role:'auditor',  can_audit:true} → can_audit FORCED false (meaningless
//     on a pure auditor — the role already audits)
//   - accept path (auth.js finalize): an invite row with can_audit:true → the professionals
//     provisioning insert carries can_audit:true AND a pseudonym is still assigned (the dual
//     role must not break the physician P-NNN series)
//   - control: a plain physician invite writes NO can_audit key at all (pre-migration tolerant)
//
// Supabase mock follows auth-flows.test.js (table-aware; ALL mutable state inside the hoisted
// jest.mock factory, re-exported as `__mock`), extended to also capture the invites insert.
// SMTP env is cleared so the mailer stays disabled — mail delivery is out of scope here.

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
        return ok({ id: 'inv-9', created_at: '2026-06-10T00:00:00.000Z', ...self._insert });  // echo created invite
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
const VALID_INVITE_TOKEN = 'invite-raw-token-special';

// Keep the mailer disabled regardless of the shell env (it reads env at CALL time).
const MAIL_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
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
// POST /admin/invites — the can_audit flag on creation
// ---------------------------------------------------------------------------

test('Special invite: {role: physician, can_audit: true} → invites insert with can_audit:true', async () => {
  m.state.caller = SUPERADMIN;

  const r = await auth(request(app).post('/admin/invites')).send({
    email: 'special@example.com', role: 'physician', can_audit: true, council_id: COUNCIL_ID,
  });

  expect(r.status).toBe(201);
  expect(m.state.lastInviteInsert).toMatchObject({
    email: 'special@example.com', role: 'physician', can_audit: true, council_id: COUNCIL_ID, status: 'pending',
  });
  expect(r.body.can_audit).toBe(true);                         // the created row echoes the flag
  expect(r.body.accept_url).toMatch(/\/invite\.html\?token=/); // normal invite plumbing intact
});

test('{role: auditor, can_audit: true} → can_audit FORCED false on the insert', async () => {
  m.state.caller = SUPERADMIN;

  const r = await auth(request(app).post('/admin/invites')).send({
    email: 'auditor@example.com', role: 'auditor', can_audit: true, council_id: COUNCIL_ID,
  });

  expect(r.status).toBe(201);
  expect(m.state.lastInviteInsert).toMatchObject({ role: 'auditor', can_audit: false });
});

// ---------------------------------------------------------------------------
// POST /auth/invite/:token/accept — can_audit flows into provisioning
// ---------------------------------------------------------------------------

test('accepting a Special invite → professional provisioned with can_audit:true AND a pseudonym', async () => {
  m.state.invite = pendingInvite('physician', { can_audit: true });
  m.auth.verifyOtp = otpUser({
    id: 'phys-special', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'หมอพิเศษ', full_name_en: 'Special Doc' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'หมอพิเศษ', full_name_en: 'Special Doc',
  });

  expect(r.status).toBe(201);
  expect(r.body.status).toBe('active');
  expect(m.state.lastProfInsert).toMatchObject({
    id: 'phys-special', role: 'physician', status: 'active',
    can_audit: true,        // the Special flag landed on the professionals row
    pseudonym: 'P-001',     // and the physician still enters the P-NNN series
  });
  expect(r.body.user).toMatchObject({ can_audit: true, pseudonym: 'P-001' });
});

test('accepting a PLAIN physician invite → no can_audit key written (pre-migration tolerant)', async () => {
  m.state.invite = pendingInvite('physician');   // no can_audit on the invite row
  m.auth.verifyOtp = otpUser({
    id: 'phys-plain', email: 'invitee@example.com',
    invite_signup: { full_name_th: 'หมอ', full_name_en: 'Doc' },
  });

  const r = await request(app).post(`/auth/invite/${VALID_INVITE_TOKEN}/accept`).send({
    method: 'password', otp: '123456', password: 'Str0ng!Passw0rd', full_name_th: 'หมอ', full_name_en: 'Doc',
  });

  expect(r.status).toBe(201);
  expect(m.state.lastProfInsert).toMatchObject({ id: 'phys-plain', role: 'physician', pseudonym: 'P-001' });
  expect(m.state.lastProfInsert.can_audit).toBeUndefined();
});
