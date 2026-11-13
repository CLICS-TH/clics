// GET /manifest reports the retries the anthropic provider makes after a failed attempt, so the booth table build
// (scripts/booth/build-path-tables.mjs) reserves each call's worst case from the setting rimpl actually runs with.
jest.mock('../src/lib/supabase', () => ({ supabase: { from: () => ({}) } }));

const request = require('supertest');

let saved;
beforeEach(() => { saved = process.env.CLAUDE_MAX_RETRIES; jest.resetModules(); });
afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_MAX_RETRIES; else process.env.CLAUDE_MAX_RETRIES = saved; });

test.each([['2', 2], [undefined, 5]])('with CLAUDE_MAX_RETRIES=%s it reports provider_retries.anthropic %s', async (env, want) => {
  if (env === undefined) delete process.env.CLAUDE_MAX_RETRIES; else process.env.CLAUDE_MAX_RETRIES = env;
  const app = require('../src/index');
  const res = await request(app).get('/manifest');
  expect(res.status).toBe(200);
  expect(res.body.provider_retries).toEqual({ anthropic: want });
});
