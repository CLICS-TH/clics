// POST /admin/invites — fail-soft email delivery (src/lib/mailer.js). The invite row is created
// FIRST; mail is best-effort on top. Contract under test:
//   - mailer disabled (no SMTP_HOST/MAIL_FROM) → 201, email_sent:false, sendMail never called
//   - mailer enabled + SMTP accepts             → 201, email_sent:true
//   - mailer enabled + SMTP REJECTS             → STILL 201 with accept_url, email_sent:false
// (A mail failure must never fail invite creation — the dashboard falls back to copy-link.)
//
// nodemailer is required LAZILY inside getTransport(), so jest.mock('nodemailer') intercepts it at
// send time; `mockSendMail` is mock-prefixed so the hoisted factory may close over it. The mailer
// also caches its transport, so each test resets env AND calls _resetTransport(). Supabase mock
// follows auth-flows.test.js (all state inside the hoisted factory, re-exported as `__mock`).

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: (...args) => mockSendMail(...args) })),
}));

// Slot precheck is accounts.js's concern (own tests) — force "slot available" here.
jest.mock('../src/lib/accounts', () => ({
  assertSlotAvailable: jest.fn(() => Promise.resolve({ ok: true })),
  nextPseudonym: jest.fn(() => Promise.resolve('P-001')),
}));

jest.mock('../src/lib/supabase', () => {
  const state = {
    caller: { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null },
    insertError: null,   // set to simulate a failed invites insert
    updates: [],         // recorded update payloads per table: { table, payload }
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const self = { _op: 'select', _payload: undefined };
    for (const fn of ['select', 'eq', 'order', 'range', 'limit', 'in', 'neq', 'not', 'is', 'gte', 'lte']) self[fn] = () => self;
    self.insert = (payload) => { self._op = 'insert'; self._payload = payload; return self; };
    self.update = (payload) => { self._op = 'update'; state.updates.push({ table, payload }); return self; };

    self.single = () => {
      // invites .insert({...}).select(...).single() → echo the created row
      if (table === 'invites' && self._op === 'insert') {
        if (state.insertError) return Promise.resolve({ data: null, error: state.insertError });
        const p = self._payload;
        return ok({
          id: 'inv-9', email: p.email, role: p.role, council_id: p.council_id,
          status: p.status, expires_at: p.expires_at, created_at: '2026-06-10T00:00:00.000Z',
        });
      }
      if (table === 'professionals') return ok(state.caller); // verifyJwt lookup
      return ok(null);
    };
    self.maybeSingle = () => (table === 'councils'
      ? ok({ name_th: 'แพทยสภา', name_en: 'The Medical Council' })   // council names for the email body
      : ok(null));
    // Thenable terminal: the best-effort email_sent_at stamp awaits update(...).eq(...) directly.
    self.then = (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
    return self;
  }

  const mod = {
    supabase: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
    authSupabase: { auth: {
      getUser: () => Promise.resolve({ data: { user: { id: state.caller.id, email: 'sa@test.local' } }, error: null }),
    } },
  };
  mod.__mock = { state, reset() { state.insertError = null; state.updates.length = 0; } };
  return mod;
});

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const mailer = require('../src/lib/mailer');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const COUNCIL_ID = '22222222-2222-2222-2222-222222222222';
const BODY = { email: 'invitee@example.com', role: 'physician', council_id: COUNCIL_ID };

const MAIL_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
const savedEnv = {};
beforeAll(() => { for (const k of MAIL_ENV) savedEnv[k] = process.env[k]; });
afterAll(() => {
  for (const k of MAIL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  for (const k of MAIL_ENV) delete process.env[k];  // mailer reads env at CALL time
  mailer._resetTransport();                          // drop the cached nodemailer transport
  mockSendMail.mockReset();
  m.reset();
});

const enableMailer = () => {
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.MAIL_FROM = 'CLICS <no-reply@test.local>';
};

test('SMTP env unset → 201 with accept_url, email_sent:false, sendMail never called', async () => {
  const r = await auth(request(app).post('/admin/invites')).send(BODY);

  expect(r.status).toBe(201);
  expect(r.body.email_sent).toBe(false);
  expect(r.body.accept_url).toMatch(/\/invite\.html\?token=/);
  expect(r.body.email).toBe(BODY.email);
  expect(mockSendMail).not.toHaveBeenCalled();
  // disabled mailer ⇒ no email_sent_at stamp either
  expect(m.state.updates.filter((u) => u.table === 'invites')).toHaveLength(0);
});

test('SMTP env set + sendMail resolves → 201 with email_sent:true (and email_sent_at stamped)', async () => {
  enableMailer();
  mockSendMail.mockResolvedValue({ accepted: [BODY.email] });

  const r = await auth(request(app).post('/admin/invites')).send(BODY);

  expect(r.status).toBe(201);
  expect(r.body.email_sent).toBe(true);
  expect(r.body.accept_url).toMatch(/\/invite\.html\?token=/);
  expect(mockSendMail).toHaveBeenCalledTimes(1);
  expect(mockSendMail.mock.calls[0][0]).toMatchObject({ to: BODY.email, from: process.env.MAIL_FROM });
  // the accept link must be in the message body
  expect(mockSendMail.mock.calls[0][0].text).toContain(r.body.accept_url);
  // best-effort stamp ran
  const stamps = m.state.updates.filter((u) => u.table === 'invites');
  expect(stamps).toHaveLength(1);
  expect(stamps[0].payload).toHaveProperty('email_sent_at');
});

test('SMTP env set + sendMail REJECTS → STILL 201 with accept_url, email_sent:false (fail-soft)', async () => {
  enableMailer();
  mockSendMail.mockRejectedValue(new Error('connection refused'));

  const r = await auth(request(app).post('/admin/invites')).send(BODY);

  expect(r.status).toBe(201);                                  // invite creation must not fail
  expect(r.body.email_sent).toBe(false);
  expect(r.body.accept_url).toMatch(/\/invite\.html\?token=/); // admin can still copy-link
  expect(mockSendMail).toHaveBeenCalledTimes(1);
  // send failed ⇒ NO email_sent_at stamp
  expect(m.state.updates.filter((u) => u.table === 'invites')).toHaveLength(0);
});
