// lib/internal-auth.js — the shared-secret gate in front of every rimpl route except /health and
// /health/deep. Constant-time since 2026-10-15: crypto.timingSafeEqual over two SHA-256 digests (always 32
// bytes, so a length mismatch cannot throw). The 401 body is byte-identical to before; the dev carve-out
// (no INTERNAL_TOKEN = no check) is unchanged.
jest.mock('../src/lib/supabase', () => ({ supabase: { from: () => ({}) } }));

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { internalAuth, tokenMatches } = require('../src/lib/internal-auth');

const TOKEN = 'internal-test-token-0123456789';
let saved;
beforeEach(() => { saved = process.env.INTERNAL_TOKEN; process.env.INTERNAL_TOKEN = TOKEN; });
afterEach(() => { if (saved === undefined) delete process.env.INTERNAL_TOKEN; else process.env.INTERNAL_TOKEN = saved; jest.restoreAllMocks(); });

function run(headers) {
  const req = { headers };
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const next = jest.fn();
  internalAuth(req, res, next);
  return { res, next };
}

describe('the middleware', () => {
  test('the right token passes', () => {
    const { res, next } = run({ 'x-internal-token': TOKEN });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  test.each([
    ['missing', {}],
    ['empty', { 'x-internal-token': '' }],
    ['wrong, same length', { 'x-internal-token': TOKEN.replace(/9$/, '8') }],
    ['wrong, shorter (a prefix)', { 'x-internal-token': TOKEN.slice(0, 5) }],
    ['wrong, longer', { 'x-internal-token': `${TOKEN}x` }],
    ['an array (a repeated header)', { 'x-internal-token': [TOKEN, TOKEN] }],
    ['a different case', { 'x-internal-token': TOKEN.toUpperCase() }],
  ])('%s → 401 { error: "Unauthorized" }, no throw', (_l, headers) => {
    let out;
    expect(() => { out = run(headers); }).not.toThrow();
    expect(out.next).not.toHaveBeenCalled();
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body).toEqual({ error: 'Unauthorized' });
  });

  test('no INTERNAL_TOKEN configured: the dev carve-out still skips the check', () => {
    delete process.env.INTERNAL_TOKEN;
    expect(run({}).next).toHaveBeenCalledTimes(1);
    process.env.INTERNAL_TOKEN = '';
    expect(run({ 'x-internal-token': 'anything' }).next).toHaveBeenCalledTimes(1);
  });

  test('the comparison is crypto.timingSafeEqual over equal-length buffers, whatever the guess\'s length', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    for (const guess of ['x', TOKEN.slice(0, 5), TOKEN, `${TOKEN}${'y'.repeat(500)}`]) tokenMatches(guess, TOKEN);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [a, b] of spy.mock.calls) {
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });

  test('no plain comparison of the secret is left in the source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'internal-auth.js'), 'utf8');
    expect(src).not.toMatch(/!==\s*token|token\s*!==|===\s*token|token\s*===/);
    expect(src).toMatch(/timingSafeEqual/);
  });
});

describe('through the app: every gated route answers the same 401', () => {
  const app = require('../src/index');
  test.each(['/manifest', '/evaluate', '/chat', '/evaluate-criteria', '/audit-discuss', '/deidentify'])('%s', async (route) => {
    const method = route === '/manifest' ? 'get' : 'post';
    const bad = await request(app)[method](route).set('x-internal-token', 'nope');
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'Unauthorized' });
    const none = await request(app)[method](route);
    expect(none.status).toBe(401);
  });

  test('/health and /health/deep stay open (monitors reach them without the token)', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect([200, 503]).toContain((await request(app).get('/health/deep')).status);
  });

  test('the right token reaches the route', async () => {
    const res = await request(app).get('/manifest').set('x-internal-token', TOKEN);
    expect(res.status).toBe(200);
  });
});
