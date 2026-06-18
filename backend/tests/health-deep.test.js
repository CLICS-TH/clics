// GET /health/deep aggregates the backend's Supabase reachability with RIMPL's own deep check.
// Hermetic: Supabase via the shared mock, the RIMPL probe stubbed. Mounted on a bare express app so
// the rate limiter / CORS / reconcile timer in src/index.js don't enter the picture.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({ probeRimplDeep: jest.fn() }));

process.env.HEALTH_PROBE_TIMEOUT_MS = '50'; // fast timeout for the "supabase hangs" case

const request = require('supertest');
const express = require('express');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { probeRimplDeep } = require('../src/services/rimpl-client');
const healthRouter = require('../src/routes/health');

const app = express();
app.use(express.json());
app.use('/health', healthRouter);

const supabaseUp = () => { m.state.resolve = (table) => (table === 'professionals' ? { count: 1, error: null } : undefined); };

describe('GET /health/deep (backend)', () => {
  beforeEach(() => { m.reset(); probeRimplDeep.mockReset(); });

  test('all dependencies up → 200, RIMPL deep body bubbled', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok', service: 'rimpl', model: 'claude-sonnet-4-6', checks: {} } });
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('backend');
    expect(res.body.checks.supabase.status).toBe('up');
    expect(res.body.checks.rimpl.status).toBe('up');
    expect(res.body.checks.rimpl.deep.service).toBe('rimpl');
  });

  test('backend Supabase down → 503', async () => {
    m.state.resolve = (table) => (table === 'professionals' ? { error: { message: 'db unreachable' } } : undefined);
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.supabase.status).toBe('down');
    expect(res.body.checks.supabase.error).toMatch(/db unreachable/);
  });

  test('RIMPL degraded (503 body) → 503, backend reports rimpl down + bubbles deep', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 503, body: { status: 'degraded', service: 'rimpl', checks: { supabase: { status: 'down' } } } });
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.rimpl.status).toBe('down');
    expect(res.body.checks.rimpl.httpStatus).toBe(503);
    expect(res.body.checks.rimpl.deep.checks.supabase.status).toBe('down');
  });

  test('RIMPL unreachable (probe throws) → 503, rimpl down with error and no deep body', async () => {
    supabaseUp();
    probeRimplDeep.mockRejectedValue(new Error('timeout after 2500ms'));
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.rimpl.status).toBe('down');
    expect(res.body.checks.rimpl.error).toMatch(/timeout/);
    expect(res.body.checks.rimpl.deep).toBeUndefined();
  });

  test('Supabase timeout → down (no hang) + 503', async () => {
    // The shared mock flattens a pending resolve(), so stub `from` to a genuinely hanging query.
    const realFrom = supabase.from;
    supabase.from = () => ({ select: () => ({ limit: () => new Promise(() => {}) }) });
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    try {
      const res = await request(app).get('/health/deep');
      expect(res.status).toBe(503);
      expect(res.body.checks.supabase.status).toBe('down');
      expect(res.body.checks.supabase.error).toMatch(/timeout/);
    } finally {
      supabase.from = realFrom;
    }
  });

  test('reachable without an Authorization header (no verifyJwt on this router)', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    const res = await request(app).get('/health/deep');
    expect(res.status).not.toBe(401);
    expect(res.body.service).toBe('backend');
  });
});
