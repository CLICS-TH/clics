// #203: auth-js returns an AuthError from admin calls as a value instead of throwing it, so a
// try/catch alone reported a failed revoke as success and sent an OTP for a password never set.
jest.mock('../src/lib/supabase', () => {
  const mock = require('./helpers/supabase-mock').makeSupabaseMock();
  mock.authSupabase.auth.admin = { signOut: jest.fn(), listUsers: jest.fn() };
  mock.supabase.auth = { admin: { createUser: jest.fn(), updateUserById: jest.fn(), deleteUser: jest.fn() } };
  mock.authAnon.auth.signInWithOtp = jest.fn();
  mock.authAnon.auth.verifyOtp = jest.fn();
  mock.authSupabase.auth.signInWithPassword = jest.fn();
  return mock;
});

const request = require('supertest');
const express = require('express');
const { hashToken } = require('../src/lib/invite-token');
const { supabase, authSupabase, authAnon, __mock: m } = require('../src/lib/supabase');
const authRouter = require('../src/routes/auth');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);

const CALLER = { id: 'u-1', email: 'u1@test.local', role: 'physician', status: 'active' };
const { AuthApiError, AuthSessionMissingError } = require('@supabase/supabase-js');
const authError = (status, message) => new AuthApiError(message, status, 'test');

let errorLog;
beforeEach(() => {
  m.reset();
  m.state.caller = CALLER;
  jest.clearAllMocks();
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

const logout = () => request(app).post('/auth/logout').set('Authorization', 'Bearer tok-1');

describe('POST /auth/logout', () => {
  it('revokes the caller\'s token globally and answers 200 { ok: true }', async () => {
    authSupabase.auth.admin.signOut.mockResolvedValue({ data: null, error: null });
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(authSupabase.auth.admin.signOut).toHaveBeenCalledWith('tok-1', 'global');
  });

  it('answers 502 revoke_failed and logs when the revoke returns an error', async () => {
    authSupabase.auth.admin.signOut.mockResolvedValue({ data: null, error: authError(500, 'gotrue down') });
    const res = await logout();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'revoke_failed', error: expect.any(String) });
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/500.*gotrue down/);
  });

  it.each([401, 404])('treats a %i (session already gone) as signed out', async (status) => {
    authSupabase.auth.admin.signOut.mockResolvedValue({ data: null, error: authError(status, 'session not found') });
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(errorLog).not.toHaveBeenCalled();
  });

  // auth-js maps GoTrue's session_not_found, at any HTTP status, to this error with status 400.
  it('treats session_not_found (AuthSessionMissingError) as signed out, with no error log', async () => {
    authSupabase.auth.admin.signOut.mockResolvedValue({ data: null, error: new AuthSessionMissingError() });
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('answers 502 revoke_failed and logs when the revoke throws', async () => {
    authSupabase.auth.admin.signOut.mockRejectedValue(new TypeError('fetch failed'));
    const res = await logout();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'revoke_failed' });
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/fetch failed/);
  });
});

describe('POST /auth/invite/:token/accept, half-provisioned recovery', () => {
  const RAW = 'invite-raw-token-abc';
  const PENDING = {
    id: 'inv-1', email: 'invitee@example.com', role: 'physician', council_id: 'c-1', status: 'pending',
    token_hash: hashToken(RAW), expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  const PASSWORD = 'Str0ng!Passw0rd';
  const NAMES = { full_name_th: 'ทดสอบ', full_name_en: 'Test' };
  const accept = (extra = {}) => request(app).post(`/auth/invite/${RAW}/accept`).send({
    method: 'password', ...NAMES, ...extra,
  });
  const sendCode = () => accept({ password: PASSWORD });
  const verifyCode = (extra = {}) => accept({ otp: '123456', password: PASSWORD, ...extra });

  let professional;
  beforeEach(() => {
    professional = undefined;
    m.state.resolve = (table, kind) => {
      if (table === 'invites') return PENDING;
      if (table === 'professionals' && kind === 'maybeSingle') return professional;
      if (table === 'professionals' && kind === 'single') return { id: 'auth-9', role: 'physician', status: 'active' };
      return undefined;
    };
    supabase.auth.admin.createUser.mockResolvedValue({ data: null, error: authError(422, 'already registered') });
    authSupabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [{ id: 'auth-9', email: PENDING.email }] }, error: null });
    authAnon.auth.signInWithOtp.mockResolvedValue({ error: null });
    authAnon.auth.verifyOtp.mockResolvedValue({
      data: { user: { id: 'auth-9', email: PENDING.email, user_metadata: {} }, session: { access_token: 'sess-9' } }, error: null,
    });
    supabase.auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: 'auth-9' } }, error: null });
    authSupabase.auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: 'fresh-tok' } }, error: null });
  });

  describe('step 1, send the code', () => {
    it('creates a fresh user with a server-generated password, never the one the link holder sent', async () => {
      supabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'auth-new' } }, error: null });
      const res = await sendCode();
      expect(res.status).toBe(202);
      expect(supabase.auth.admin.createUser).toHaveBeenCalledTimes(1);
      const arg = supabase.auth.admin.createUser.mock.calls[0][0];
      expect(arg.password).not.toBe(PASSWORD);
      expect(arg.password).toEqual(expect.any(String));
      expect(arg.password.length).toBeGreaterThanOrEqual(32);
      expect(arg).toMatchObject({ email: PENDING.email, email_confirm: false });
    });

    it('still rejects a weak password at step 1', async () => {
      const res = await accept({ password: 'weak' });
      expect(res.status).toBe(400);
      expect(supabase.auth.admin.createUser).not.toHaveBeenCalled();
    });

    it('sends the code and does NOT set the password on the existing auth user', async () => {
      const res = await sendCode();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'otp_sent', email: PENDING.email });
      expect(authAnon.auth.signInWithOtp).toHaveBeenCalledTimes(1);
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
    });

    it('answers 409 and sends no code when the email is already registered', async () => {
      professional = { id: 'auth-9' };
      const res = await sendCode();
      expect(res.status).toBe(409);
      expect(authAnon.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
    });

    it('answers 502 and sends no code when the user lookup fails', async () => {
      authSupabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: authError(500, 'list failed') });
      const res = await sendCode();
      expect(res.status).toBe(502);
      expect(authAnon.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(errorLog.mock.calls.flat().join(' ')).toMatch(/500.*list failed/);
    });

    it('answers 502 and sends no code when the lookup throws', async () => {
      authSupabase.auth.admin.listUsers.mockRejectedValue(new TypeError('fetch failed'));
      const res = await sendCode();
      expect(res.status).toBe(502);
      expect(authAnon.auth.signInWithOtp).not.toHaveBeenCalled();
    });

    it('answers 502 and sends no code when createUser failed but no auth user has the email', async () => {
      authSupabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
      supabase.auth.admin.createUser.mockResolvedValue({ data: null, error: authError(500, 'db down') });
      const res = await sendCode();
      expect(res.status).toBe(502);
      expect(authAnon.auth.signInWithOtp).not.toHaveBeenCalled();
    });
  });

  describe('step 2, verify the code', () => {
    it('sets the password only after the code verifies, then provisions', async () => {
      const res = await verifyCode();
      expect(res.status).toBe(201);
      expect(supabase.auth.admin.updateUserById).toHaveBeenCalledWith('auth-9', expect.objectContaining({ password: PASSWORD }));
      expect(authAnon.auth.verifyOtp.mock.invocationCallOrder[0])
        .toBeLessThan(supabase.auth.admin.updateUserById.mock.invocationCallOrder[0]);
      expect(m.find('professionals', 'insert')).toBeDefined();
    });

    it('returns a token minted after the password update, not the verifyOtp session GoTrue just deleted', async () => {
      const res = await verifyCode();
      expect(res.body.access_token).toBe('fresh-tok');
      expect(authSupabase.auth.signInWithPassword).toHaveBeenCalledWith({ email: PENDING.email, password: PASSWORD });
      expect(supabase.auth.admin.updateUserById.mock.invocationCallOrder[0])
        .toBeLessThan(authSupabase.auth.signInWithPassword.mock.invocationCallOrder[0]);
    });

    it('answers 502 and provisions nothing when the sign-in after the password update fails', async () => {
      authSupabase.auth.signInWithPassword.mockResolvedValue({ data: null, error: authError(500, 'sign-in failed') });
      const res = await verifyCode();
      expect(res.status).toBe(502);
      expect(m.find('professionals', 'insert')).toBeUndefined();
    });

    it('answers 400 and sets no password when the code is wrong', async () => {
      authAnon.auth.verifyOtp.mockResolvedValue({ data: null, error: authError(403, 'otp expired') });
      const res = await verifyCode();
      expect(res.status).toBe(400);
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(m.find('professionals', 'insert')).toBeUndefined();
    });

    it('answers 400 when the password is missing', async () => {
      const res = await accept({ otp: '123456' });
      expect(res.status).toBe(400);
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
    });

    it('answers 409 and leaves the password alone when the verified user is already registered', async () => {
      professional = { id: 'auth-9' };
      const res = await verifyCode();
      expect(res.status).toBe(409);
      expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(m.find('professionals', 'insert')).toBeUndefined();
    });

    it('answers 502 and provisions nothing when setting the password fails', async () => {
      supabase.auth.admin.updateUserById.mockResolvedValue({ data: null, error: authError(500, 'update failed') });
      const res = await verifyCode();
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/try again/i);
      expect(m.find('professionals', 'insert')).toBeUndefined();
      expect(errorLog).toHaveBeenCalled();
    });
  });
});
