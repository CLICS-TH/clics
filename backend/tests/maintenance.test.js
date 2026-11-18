// CLICS_MAINTENANCE=1 (#432): during the database-move window nothing may write to the source, so every
// route but /health answers 503 (reads too: some GETs write an audit row). Exercised through the real
// app from src/index.js, so the middleware's position (before every router) is what is tested.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const { supabase } = require('../src/lib/supabase');
const app = require('../src/index');

const fromSpy = jest.spyOn(supabase, 'from');
const rpcSpy = jest.spyOn(supabase, 'rpc');
const touched = () => fromSpy.mock.calls.length + rpcSpy.mock.calls.length;

describe('CLICS_MAINTENANCE', () => {
  afterEach(() => { delete process.env.CLICS_MAINTENANCE; });

  test.each([
    ['GET', '/ples'],
    ['POST', '/ples'],
    ['POST', '/auth/login'],
    ['GET', '/auth/me'],
    ['PATCH', '/admin/settings'],
    ['DELETE', '/ples/00000000-0000-0000-0000-000000000001'],
    ['POST', '/booth/plays'],
  ])('on: %s %s → 503 before any route touches the database', async (method, path) => {
    process.env.CLICS_MAINTENANCE = '1';
    const before = touched();
    const res = await request(app)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(503);
    expect(res.body.maintenance).toBe(true);
    expect(res.headers['retry-after']).toBe('1800');
    expect(touched()).toBe(before);
  });

  test('on: GET /health still answers 200', async () => {
    process.env.CLICS_MAINTENANCE = '1';
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('on: the 503 keeps its CORS headers, so the Portal can read it', async () => {
    process.env.CLICS_MAINTENANCE = '1';
    process.env.ALLOWED_ORIGINS = 'https://clics.example.invalid';
    try {
      const res = await request(app).get('/ples').set('Origin', 'https://clics.example.invalid');
      expect(res.status).toBe(503);
      expect(res.headers['access-control-allow-origin']).toBe('https://clics.example.invalid');
    } finally { delete process.env.ALLOWED_ORIGINS; }
  });

  test.each([undefined, '', '0', 'true', 'yes'])('off when CLICS_MAINTENANCE is %p: routes run as before', async (v) => {
    if (v !== undefined) process.env.CLICS_MAINTENANCE = v;
    const res = await request(app).get('/ples');
    expect(res.status).not.toBe(503);
  });
});
