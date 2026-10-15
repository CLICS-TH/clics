// GET /health/deep aggregates the backend's Supabase reachability with RIMPL's own deep check.
// Hermetic: Supabase via the shared mock, the RIMPL probe stubbed. Mounted on a bare express app so
// the rate limiter / CORS / reconcile timer in src/index.js don't enter the picture.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({ probeRimplDeep: jest.fn(), fetchRimplManifest: jest.fn() }));
// The drain runs in the main process, never under test — so stub its status(), which is the only
// thing /health/deep reads from it. Default is the healthy-idle shape a fresh drain reports.
jest.mock('../src/services/eval-drain', () => ({ status: jest.fn() }));

process.env.HEALTH_PROBE_TIMEOUT_MS = '50'; // fast timeout for the "supabase hangs" case

const request = require('supertest');
const express = require('express');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { probeRimplDeep, fetchRimplManifest } = require('../src/services/rimpl-client');
const { evaluatorDigest, resetManifestCache } = require('../src/services/model-lock');
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

  // A drain paused on an exhausted budget pool claims nothing, which is byte-identical to a healthy
  // idle drain from outside. It surfaces immediately rather than eventually arriving as
  // `queue_stuck`, because the two need opposite responses: raise the cap, versus find the fault.
  test('budget pool exhausted → 503 with its own reason, not queue_stuck', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    evalDrain.status.mockReturnValue({ ...IDLE_DRAIN, running: true,
      pool: { cap: 12, spent: 12.4, exhausted: true, uncapped: false } });

    const res = await request(app).get('/health/deep');

    expect(res.status).toBe(503);
    expect(res.body.checks.eval_queue.status).toBe('down');
    // The numbers travel with the reason, so an operator can act without opening another screen.
    expect(res.body.checks.eval_queue.reasons).toContain('budget_pool_exhausted:12.4/12');
    expect(res.body.checks.eval_queue.reasons).not.toContain('queue_stuck');
    expect(res.body.checks.supabase.status).toBe('up');
  });

  test('an uncapped pool is not a degraded one — the shipped default must stay green', async () => {
    supabaseUp();
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok' } });
    evalDrain.status.mockReturnValue({ ...IDLE_DRAIN, pool: { cap: 0, spent: null, exhausted: false, uncapped: true } });
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.checks.eval_queue.reasons).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// checks.model_lock (CCME R2). The lock FREEZES THE SCORING INSTRUMENT: POST /admin/evaluator-lock stores
// an evaluator digest (services/model-lock.js evaluatorDigest, over exactly the evaluator keys of the
// model manifest), and while locked /health/deep recomputes it on rimpl's live GET /manifest (cached
// <= 60 s). Only an evaluator change degrades. A tutor/router/chat change is a note. Unlocked —
// production today — never degrades and fetches nothing.
// ---------------------------------------------------------------------------------------------
describe('checks.model_lock', () => {
  const FROZEN = 'f'.repeat(64);
  const OTHER = 'e'.repeat(64);
  const LOCKED_AT = '2026-10-15T01:02:03.000Z';
  // The shape of rimpl/src/model-manifest.json's expected half (values abridged).
  const EXPECTED = Object.freeze({
    code: {
      anthropic: { model: 'claude-sonnet-4-6', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6' },
      model_version_prefix: 'CCME_LLM_v8.0+',
      evaluator: { prompt_version: { anthropic: 'pis7-prompt-59561c29', local: 'pis7-prompt-59561c29+local-c5ffe572aa81' },
        rubric_version: 'pis7-weights-08b0cb1a' },
      decoding: { evaluate: { max_tokens: 4096, temperature: 0 }, chat: { max_tokens: 1024, temperature: 0.7 } },
      consistency: {
        agree: { max_domain_delta: 1, max_sum_delta: { default: 0, env: 'EVAL_CONSISTENCY_MAX_SUM_DELTA' } },
        evaluate: { json_retries: { default: 2, env: 'EVAL_JSON_RETRIES' }, mode: { applies_to: 'local', default: 'off', env: 'EVAL_CONSISTENCY' } },
        method: 'self-consistency', modes: ['off', 'adaptive', 'median3'],
        rules: { median: 'median-of-3', pair: 'first-of-agreeing-pair', single: 'single' },
        shadow: { json_retries: 0, mode: { default: 'off', env: 'SHADOW_EVAL_CONSISTENCY' } },
      },
      providers: { allowed: { evaluate: ['anthropic', 'local'], chat: ['anthropic', 'local', 'local-tutor'] } },
      prompts: { chat: 'tutor-prompt-1111', criteria: 'criteria-2222' },
      router: { fast: 'local-tutor', deep: 'local', threshold: 0.5 },
      thinking: { chat: 'off' },
    },
    declared: {
      providers: { evaluate: 'local', chat: 'local-tutor' },
      local: { engine: 'vllm', model: 'deepseek-v4-flash-dspark', role: 'evaluator' },
      'local-tutor': { engine: 'vllm', model: 'qwen-tutor-7b', role: 'tutor' },
    },
  });
  const clone = () => JSON.parse(JSON.stringify(EXPECTED));
  const EVAL = evaluatorDigest(EXPECTED, 'local');
  const lockedRow = (over = {}) => ({ provider: 'local', manifest_sha256: FROZEN, evaluator_sha256: EVAL, ...over });

  beforeEach(() => {
    m.reset(); probeRimplDeep.mockReset(); fetchRimplManifest.mockReset();
    evalDrain.status.mockReturnValue(IDLE_DRAIN); invalidateScope(); resetManifestCache();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  // `lock`: { locked_at?, row?: {...}|null, rowError?, readError? }. `live`: the GET /manifest answer
  // (expected half + whole sha), or an Error to reject with.
  function world({ lock = {}, live = { expected: EXPECTED, sha256: FROZEN }, deepSha = FROZEN } = {}) {
    m.state.resolve = (table, kind, c) => {
      if (table === 'professionals') return { count: 1, error: null };
      if (table === 'app_settings' && kind === 'maybeSingle' && c.id('key') === 'evaluator_locked_at') {
        if (lock.readError) return { data: null, error: { message: lock.readError } };
        return lock.locked_at ? { value_text: lock.locked_at } : null;
      }
      if (table === 'evaluator_model_lock' && kind === 'maybeSingle') {
        if (lock.rowError) return { data: null, error: lock.rowError };
        // The record in force is the one whose locked_at the flag carries.
        const eq = c.eqs.find(([col]) => col === 'locked_at');
        return lock.row && eq && eq[1] === lock.locked_at ? { id: 'lock-1', locked_at: lock.locked_at, ...lock.row } : null;
      }
      return undefined;
    };
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok', service: 'rimpl', checks: {},
      manifest: deepSha === 'absent' ? undefined : { sha256: deepSha, file: deepSha ? 'present' : 'missing', code_match: true, drift: [] } } });
    if (live instanceof Error) fetchRimplManifest.mockRejectedValue(live);
    else {
      fetchRimplManifest.mockResolvedValue({
        manifest: { schema: 'clics-model-manifest/v1', expected: live.expected, sha256: live.sha256 },
        sha256: live.sha256, claimed_sha256: live.sha256, file: live.file ?? 'present',
        code_match: live.code_match ?? true, live: {}, drift: [],
      });
    }
  }
  const get = () => request(app).get('/health/deep');
  const locked = (row = lockedRow()) => ({ locked_at: LOCKED_AT, row });

  describe('unlocked (production today)', () => {
    test('informational, never degraded, and no manifest fetch — whatever rimpl reports', async () => {
      // 'absent': an older rimpl whose /health/deep has no manifest block at all.
      for (const deepSha of ['absent', null, OTHER]) {
        world({ deepSha, live: new Error('must not be fetched') });
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.checks.model_lock).toEqual({ status: 'up', locked: false, locked_at: null,
          manifest_sha256: null, live_sha256: deepSha === OTHER ? OTHER : null, match: null });
      }
      expect(fetchRimplManifest).not.toHaveBeenCalled();
    });

    test('before the migration (columns missing) → 200, the record is not even read', async () => {
      world({ lock: { rowError: { code: '42703', message: 'column evaluator_model_lock.evaluator_sha256 does not exist' } } });
      const res = await get();
      expect(res.status).toBe(200);
      expect(m.all('evaluator_model_lock')).toHaveLength(0);
      expect(fetchRimplManifest).not.toHaveBeenCalled();
    });
  });

  describe('locked: only the evaluator decides', () => {
    test('the frozen manifest, unchanged → 200, match, no note', async () => {
      world({ lock: locked() });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.checks.model_lock).toEqual({ status: 'up', locked: true, locked_at: LOCKED_AT, provider: 'local',
        manifest_sha256: FROZEN, evaluator_sha256: EVAL, live_sha256: FROZEN, live_evaluator_sha256: EVAL, match: true });
    });

    test('a TUTOR / ROUTER / CHAT change → 200 with a note and both shas', async () => {
      const live = clone();
      live.code.router.threshold = 0.8;
      live.code.prompts.chat = 'tutor-prompt-3333';
      live.code.decoding.chat.temperature = 0.2;
      live.code.thinking.chat = 'on';
      live.code.providers.allowed.chat = ['anthropic', 'local-tutor'];
      live.declared.providers.chat = 'local';
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.model_lock).toMatchObject({ status: 'up', match: true, note: 'tutor_or_router_changed_since_lock',
        manifest_sha256: FROZEN, live_sha256: OTHER, evaluator_sha256: EVAL, live_evaluator_sha256: EVAL });
    });

    test('another provider\'s declared block (the tutor\'s model) → 200 with the note', async () => {
      const live = clone();
      live.declared['local-tutor'].model = 'qwen-tutor-14b';
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'up', note: 'tutor_or_router_changed_since_lock' });
    });

    test('the SHADOW evaluator\'s consistency mode changing → 200 with the note', async () => {
      const live = clone();
      live.code.consistency.shadow.mode.default = 'median3';
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'up', match: true, note: 'tutor_or_router_changed_since_lock' });
    });

    test('agree.max_domain_delta changing → 503: how repeated local scores are reconciled is the instrument', async () => {
      const live = clone();
      live.code.consistency.agree.max_domain_delta = 2;
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'down', reason: 'evaluator_changed_since_lock' });
    });

    test('an EVALUATOR prompt / addendum change → 503, evaluator_changed_since_lock', async () => {
      const live = clone();
      live.code.evaluator.prompt_version.local = 'pis7-prompt-59561c29+local-000000000000';
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.model_lock).toMatchObject({ status: 'down', match: false, reason: 'evaluator_changed_since_lock',
        evaluator_sha256: EVAL, live_sha256: OTHER });
      expect(res.body.checks.model_lock.live_evaluator_sha256).not.toBe(EVAL);
      expect(res.body.checks.model_lock.note).toBeUndefined();
      // The dependencies are fine: the lock alone degrades the verdict.
      expect(res.body.checks.rimpl.status).toBe('up');
    });

    test('the locked provider\'s declared model changing → 503', async () => {
      const live = clone();
      live.declared.local.model = 'deepseek-v4-pro';
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.checks.model_lock.reason).toBe('evaluator_changed_since_lock');
    });

    test.each([
      ['the rubric', (e) => { e.code.evaluator.rubric_version = 'pis7-weights-ffffffff'; }],
      ['the model-version prefix', (e) => { e.code.model_version_prefix = 'CCME_LLM_v9.0+'; }],
      ['evaluate decoding', (e) => { e.code.decoding.evaluate.temperature = 0.3; }],
      ['evaluate consistency', (e) => { e.code.consistency.evaluate.json_retries.default = 5; }],
      ['the consistency agreement bound (agree.max_domain_delta)', (e) => { e.code.consistency.agree.max_domain_delta = 2; }],
      ['the consistency rules', (e) => { e.code.consistency.rules.pair = 'mean-of-agreeing-pair'; }],
      ['the providers allowed to evaluate', (e) => { e.code.providers.allowed.evaluate = ['local']; }],
      ['the declared evaluate provider', (e) => { e.declared.providers.evaluate = 'anthropic'; }],
    ])('%s changing → 503', async (_label, mutate) => {
      const live = clone();
      mutate(live);
      world({ lock: locked(), live: { expected: live, sha256: OTHER } });
      expect((await get()).body.checks.model_lock).toMatchObject({ status: 'down', reason: 'evaluator_changed_since_lock' });
    });

    test('the case of a frozen sha does not matter', async () => {
      world({ lock: locked(lockedRow({ evaluator_sha256: EVAL.toUpperCase() })) });
      expect((await get()).status).toBe(200);
    });
  });

  describe('locked, but the instrument cannot be shown', () => {
    test('GET /manifest unreachable or unverified → 503, live_manifest_unknown', async () => {
      for (const live of [new Error('ECONNREFUSED'), { expected: EXPECTED, sha256: FROZEN, code_match: false }, { expected: EXPECTED, sha256: FROZEN, file: 'invalid' }]) {
        resetManifestCache();
        world({ lock: locked(), live });
        const res = await get();
        expect(res.status).toBe(503);
        expect(res.body.checks.model_lock).toMatchObject({ status: 'down', match: false, reason: 'live_manifest_unknown' });
      }
    });

    test('a legacy record with no evaluator digest (pre-scope lock, or a hand-set flag) → 503, not bound, no fetch', async () => {
      world({ lock: locked(lockedRow({ evaluator_sha256: null })) });
      expect((await get()).body.checks.model_lock).toMatchObject({ status: 'down', reason: 'lock_not_bound_to_manifest' });
      world({ lock: locked(lockedRow({ evaluator_sha256: null, manifest_sha256: null })) });
      expect((await get()).body.checks.model_lock).toMatchObject({ status: 'down', reason: 'lock_not_bound_to_manifest' });
      world({ lock: locked(null) });                                   // a flag with no record behind it
      expect((await get()).body.checks.model_lock).toMatchObject({ status: 'down', reason: 'lock_not_bound_to_manifest' });
      expect(fetchRimplManifest).not.toHaveBeenCalled();
    });

    test('on an unmigrated database → 503 that says so, not a crash', async () => {
      world({ lock: { locked_at: LOCKED_AT, rowError: { code: '42703', message: 'column evaluator_model_lock.evaluator_sha256 does not exist' } } });
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'down', reason: 'lock_record_unmigrated' });
    });

    test('a record that cannot be read → 503, lock_record_unreadable', async () => {
      world({ lock: { locked_at: LOCKED_AT, rowError: { code: '57014', message: 'canceling statement due to statement timeout' } } });
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'down', reason: 'lock_record_unreadable' });
    });

    test('an unreadable lock state is reported, not degraded on: the supabase check owns a DB outage', async () => {
      world({ lock: { readError: 'connection reset' } });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.checks.model_lock).toMatchObject({ status: 'unknown', locked: null, error: 'connection reset' });
      expect(fetchRimplManifest).not.toHaveBeenCalled();
    });
  });

  describe('the live manifest is cached for at most 60 s', () => {
    test('two health checks inside the window fetch GET /manifest once; after it, again', async () => {
      let clock = Date.parse('2026-10-15T02:00:00.000Z');
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      world({ lock: locked() });
      expect((await get()).status).toBe(200);
      clock += 30_000;
      expect((await get()).status).toBe(200);
      expect(fetchRimplManifest).toHaveBeenCalledTimes(1);
      clock += 31_000;                                                  // 61 s after the first fetch
      expect((await get()).status).toBe(200);
      expect(fetchRimplManifest).toHaveBeenCalledTimes(2);
    });

    test('a failed fetch is cached too, so a down rimpl is not hammered', async () => {
      world({ lock: locked(), live: new Error('ECONNREFUSED') });
      expect((await get()).status).toBe(503);
      expect((await get()).status).toBe(503);
      expect(fetchRimplManifest).toHaveBeenCalledTimes(1);
    });

    test('the fetch carries the health timeout, not the 8 s declaration one', async () => {
      world({ lock: locked() });
      await get();
      expect(fetchRimplManifest).toHaveBeenCalledWith({ timeoutMs: 2500 });
    });
  });
});
