// Social sign-in (Google/LINE) is a stubbed handshake and must be DISABLED by default for the
// pilot (email+password only). The public mock-callback could otherwise mint pending users, so
// both routes must 404 unless OAUTH_ENABLED=true. (process.env.OAUTH_ENABLED is unset here.)
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({}) },
  authSupabase: { auth: {} },
}));

const request = require('supertest');
const express = require('express');
const authRouter = require('../src/routes/auth');
const app = express();
app.use(express.json());
app.use('/auth', authRouter);

describe('OAuth disabled by default', () => {
  test('POST /auth/oauth/:provider/start → 404', async () => {
    const r = await request(app).post('/auth/oauth/google/start');
    expect(r.status).toBe(404);
  });

  test('POST /auth/oauth/:provider/mock-callback → 404 (no public user minting)', async () => {
    const r = await request(app).post('/auth/oauth/line/mock-callback').send({ provider_subject: 'x', name: 'y' });
    expect(r.status).toBe(404);
  });
});
