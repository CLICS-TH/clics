// GET /health/deep aggregates the backend's Supabase reachability with RIMPL's own deep check.
// Hermetic: Supabase via the shared mock, the RIMPL probe stubbed. Mounted on a bare express app so
// the rate limiter / CORS / reconcile timer in src/index.js don't enter the picture.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({ probeRimplDeep: jest.fn() }));
// The drain runs in the main process, never under test — so stub its status(), which is the only
// thing /health/deep reads from it. Default is the healthy-idle shape a fresh drain reports.
jest.mock('../src/services/eval-drain', () => ({ status: jest.fn() }));

process.env.HEALTH_PROBE_TIMEOUT_MS = '50'; // fast timeout for the "supabase hangs" case

const request = require('supertest');
const express = require('express');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { probeRimplDeep } = require('../src/services/rimpl-client');
const evalDrain = require('../src/services/eval-drain');
const { invalidateScope } = require('../src/lib/eval-scope');
const healthRouter = require('../src/routes/health');

const IDLE_DRAIN = { running: false, in_flight: 0, last_tick_at: null, last_error: null,
  counters: { claimed: 0, evaluated: 0, deferred: 0, flagged: 0 }, lease_s: 300, max_attempts: 3, scope: null };

const app = express();
app.use(express.json());
app.use('/health', healthRouter);

const supabaseUp = () => { m.state.resolve = (table) => (table === 'professionals' ? { count: 1, error: null } : undefined); };

describe('GET /health/deep (backend)', () => {
  beforeEach(() => { m.reset(); probeRimplDeep.mockReset(); evalDrain.status.mockReturnValue(IDLE_DRAIN); invalidateScope(); });

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
    // The evaluation queue is reported for operators and the sandbox smoke — and it CAN fail the verdict.
    expect(res.body.checks.eval_queue).toMatchObject({ queued: 0, scoring: 0, oldest_wait_s: 0, status: 'up', stuck: false, reasons: [] });
    expect(res.body.checks.eval_queue.oldest_claimable_wait_s).toBe(0);
    expect(res.body.checks.eval_queue.drain).toMatchObject({ running: false, in_flight: 0 });
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


  // ---------------------------------------------------------------------------------------------
  // The evaluation queue MUST be able to fail the verdict.
  //
  // It used to be informational, and that is how a three-day production outage stayed invisible:
  // on 2026-09-02, with every session query failing against a renamed schema, this endpoint
  // answered 200 "ok". A drain that claims nothing looks exactly like a healthy idle one unless
  // the check asks whether work is actually moving.
  // ---------------------------------------------------------------------------------------------

  test('drain last tick threw → 503 with reason last_tick_failed', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    // lastError is cleared on every successful tick, so a value here means the drain is failing NOW.
    evalDrain.status.mockReturnValue({ ...IDLE_DRAIN, running: true, last_error: 'claim_ple_evaluations does not exist' });

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.eval_queue.status).toBe('down');
    expect(res.body.checks.eval_queue.reasons).toContain('last_tick_failed');
    // The dependencies themselves are fine — the queue alone is what degrades the verdict.
    expect(res.body.checks.supabase.status).toBe('up');
    expect(res.body.checks.rimpl.status).toBe('up');
  });

  test('council scope failed closed → 503 (a typo in the exclude setting stops ALL scoring)', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    evalDrain.status.mockReturnValue({
      ...IDLE_DRAIN, running: true,
      scope: { exclude_codes: [], include_codes: [], failed_closed: 'unknown_council:SANDOX' },
    });

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(503);
    expect(res.body.checks.eval_queue.reasons).toContain('scope_failed_closed:unknown_council:SANDOX');
  });

  // The two maybeSingle reads on `ples` differ by the claimable predicate: the stuck signal adds an
  // .or() on eval_next_at, so `iss`/`ors` tell them apart. This mirrors claim_ple_evaluations.
  const claimableRead = (c) => c.ors.some((o) => String(o).includes('eval_next_at'));
  const agesAgo = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString();

  test('claimable work waiting past the grace period → 503 with reason queue_stuck', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    const longAgo = agesAgo();
    m.state.resolve = (table, kind, c) => {
      if (table === 'professionals') return { count: 1, error: null };
      if (table === 'ples' && kind === 'maybeSingle' && claimableRead(c)) {
        return { data: { eval_enqueued_at: longAgo }, error: null };
      }
      return undefined;
    };

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(503);
    expect(res.body.checks.eval_queue.stuck).toBe(true);
    expect(res.body.checks.eval_queue.reasons).toContain('queue_stuck');
    expect(res.body.checks.eval_queue.oldest_claimable_wait_s).toBeGreaterThan(res.body.checks.eval_queue.stuck_after_s);
  });

  // A row deferred with backoff has eval_next_at in the future, so claim_ple_evaluations skips it on
  // purpose. It is being retried correctly and must not read as abandoned — this is the case a flat
  // "oldest unclaimed row" signal gets wrong, and it can persist for hours under the retry policy.
  test('a row backing off is NOT stuck — the claimable read excludes it', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    const longAgo = agesAgo();
    m.state.resolve = (table, kind, c) => {
      if (table === 'professionals') return { count: 1, error: null };
      // The unfiltered read still sees the old row; the claimable read does not.
      if (table === 'ples' && kind === 'maybeSingle' && !claimableRead(c)) {
        return { data: { eval_enqueued_at: longAgo }, error: null };
      }
      return undefined;
    };

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(200);
    expect(res.body.checks.eval_queue.stuck).toBe(false);
    expect(res.body.checks.eval_queue.oldest_wait_s).toBeGreaterThan(900);      // reported...
    expect(res.body.checks.eval_queue.oldest_claimable_wait_s).toBe(0);         // ...but not counted
  });

  // The grace scales with what the queue itself predicts, so a legitimate cohort backlog — the
  // product tells the physician "position 11, ~16 min" and means it — does not read as a failure.
  test('the grace period scales with the queue depth, not a flat 900s', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    m.state.resolve = (table, kind) => {
      if (table === 'professionals') return { count: 1, error: null };
      if (table === 'ples' && kind !== 'maybeSingle') return { count: 40, error: null };
      return undefined;
    };

    const res = await request(app).get('/health/deep');

    // 40 queued at the seeded concurrency 1 / p50 90s → 3600s predicted, well past the 900s floor.
    expect(res.body.checks.eval_queue.queued).toBe(40);
    expect(res.body.checks.eval_queue.stuck_after_s).toBeGreaterThan(900);
    expect(res.status).toBe(200);
  });

  // Finding that produced this test: the stuck signal first filtered on `is_test`, on the belief
  // that an excluded council's sessions are all test sessions. They are not — is_test comes from
  // the GLOBAL pilot_test_mode setting and has no council relationship. One ordinary session in an
  // excluded council would then have wedged this endpoint at 503 permanently. The signal must ask
  // the council question directly, the same way claim_ple_evaluations does.
  test('an EXCLUDED council is filtered out by council_id, not by is_test', async () => {
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    m.state.resolve = (table, kind, c) => {
      if (table === 'professionals') return { count: 1, error: null };
      // eval_drain_exclude_councils = SANDBOX, resolving to one council id.
      if (table === 'app_settings' && c.id('key') === 'eval_drain_exclude_councils') {
        return { data: { value_text: 'SANDBOX' }, error: null };
      }
      if (table === 'councils') return { data: [{ id: 'council-sbx', code: 'SANDBOX' }], error: null };
      return undefined;
    };

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(200);
    // The claimable read carries the council exclusion and NO is_test filter.
    const claimable = m.state.queries.find((q) => q.table === 'ples'
      && q.ors.some((o) => String(o).includes('eval_next_at')));
    expect(claimable).toBeDefined();
    expect(claimable.ors.some((o) => String(o).includes('council_id.not.in.(council-sbx)'))).toBe(true);
    expect(claimable.eqs.some((e) => e[0] === 'is_test')).toBe(false);
  });

  test('reachable without an Authorization header (no verifyJwt on this router)', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    const res = await request(app).get('/health/deep');
    expect(res.status).not.toBe(401);
    expect(res.body.service).toBe('backend');
  });
});
