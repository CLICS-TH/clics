// New signup/auth surface: forgot-password must never leak account existence (always 200),
// Google complete is gated, and input validation rejects bad signups before any side effect.
const mockResetCalls = [];
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) },
  authSupabase: { auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no' } }) } },
  authAnon: { auth: {
    resetPasswordForEmail: (email) => { mockResetCalls.push(email); return Promise.resolve({ error: null }); },
    signInWithOtp: () => Promise.resolve({ error: null }),
  } },
}));

const request = require('supertest');
const express = require('express');
const authRouter = require('../src/routes/auth');
const app = express();
app.use(express.json());
app.use('/auth', authRouter);

beforeEach(() => { mockResetCalls.length = 0; });

test('POST /auth/forgot-password always returns 200 (no existence leak)', async () => {
  const r = await request(app).post('/auth/forgot-password').send({ email: 'whoever@example.com' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(mockResetCalls).toContain('whoever@example.com');
});

test('forgot-password still 200 even if the reset call rejects', async () => {
  const sb = require('../src/lib/supabase');
  sb.authAnon.auth.resetPasswordForEmail = () => Promise.reject(new Error('smtp down'));
  const r = await request(app).post('/auth/forgot-password').send({ email: 'x@example.com' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
});

test('forgot-password rejects a non-email body (400)', async () => {
  const r = await request(app).post('/auth/forgot-password').send({ email: 'not-an-email' });
  expect(r.status).toBe(400);
});

test('POST /auth/oauth/google/complete is 404 while OAUTH_ENABLED is unset', async () => {
  const r = await request(app).post('/auth/oauth/google/complete').send({ access_token: 'x'.repeat(20), council_id: '11111111-1111-1111-1111-111111111111' });
  expect(r.status).toBe(404);
});

test('POST /auth/signup/email rejects missing license_number (400)', async () => {
  const r = await request(app).post('/auth/signup/email').send({
    email: 'a@b.co', password: 'longenough1', council_id: '11111111-1111-1111-1111-111111111111',
    full_name_th: 'ก', full_name_en: 'A',
  });
  expect(r.status).toBe(400);
});
