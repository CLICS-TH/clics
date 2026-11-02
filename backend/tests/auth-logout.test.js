// #203: auth-js returns an AuthError from admin calls as a value instead of throwing it, so a
// try/catch alone reported a failed revoke as success and sent an OTP for a password never set.
jest.mock('../src/lib/supabase', () => {
  const mock = require('./helpers/supabase-mock').makeSupabaseMock();
  mock.authSupabase.auth.admin = { signOut: jest.fn(), listUsers: jest.fn() };
  mock.supabase.auth = { admin: { createUser: jest.fn(), updateUserById: jest.fn(), deleteUser: jest.fn() } };
  mock.authAnon.auth.signInWithOtp = jest.fn();
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
  const accept = () => request(app).post(`/auth/invite/${RAW}/accept`).send({
    method: 'password', password: 'Str0ng!Passw0rd', full_name_th: 'ทดสอบ', full_name_en: 'Test',
  });

  beforeEach(() => {
    m.state.resolve = (table) => (table === 'invites' ? PENDING : undefined);
    supabase.auth.admin.createUser.mockResolvedValue({ data: null, error: authError(422, 'already registered') });
    authSupabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [{ id: 'auth-9', email: PENDING.email }] }, error: null });
    authAnon.auth.signInWithOtp.mockResolvedValue({ error: null });
  });

  it('reuses the pending user and sends the code when the password is set', async () => {
    supabase.auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: 'auth-9' } }, error: null });
    const res = await accept();
    expect(res.status).toBe(202);
    expect(supabase.auth.admin.updateUserById).toHaveBeenCalledWith('auth-9', expect.objectContaining({ password: 'Str0ng!Passw0rd' }));
    expect(authAnon.auth.signInWithOtp).toHaveBeenCalled();
  });

  it('answers 502 and sends no code when setting the password fails', async () => {
    supabase.auth.admin.updateUserById.mockResolvedValue({ data: null, error: authError(500, 'update failed') });
    const res = await accept();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/try again/i);
    expect(authAnon.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });
});
