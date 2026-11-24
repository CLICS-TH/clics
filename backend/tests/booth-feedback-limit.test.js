// Own file: the rate limiter's in-memory count is per process, so no other test's requests count against it. The two
// tests share one minute's count and run in this order.
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const app = require('../src/index');

// An empty body is refused as bad_request before any database read: the limiter is all this file exercises.
const post = () => request(app).post('/booth/feedback').send({});

it('feedback has its own per-IP limit', async () => {
  for (let i = 0; i < 30; i += 1) expect((await post()).status).toBe(400);
  expect((await post()).status).toBe(429);
});

it('feedback calls stay out of the kiosk general budget', async () => {
  // 45 calls in all, past the general limit of 40 a minute: none of them was counted against it.
  for (let i = 0; i < 14; i += 1) await post();
  expect((await request(app).get('/booth/status')).status).toBe(200);
});
