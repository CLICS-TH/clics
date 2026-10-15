// GET /oversight/icc/three-way — Claude vs auditor, candidate (shadow) vs auditor, Claude vs candidate.
//
// The suite that matters most here is the ROLE GUARD one: shadow_evaluations is RLS deny-all, but the
// backend runs as the service role and bypasses RLS, so the guard below is the ONLY thing keeping a
// second AI score away from a blinded auditor.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { computeICC21, iccTwoRater } = require('../src/services/icc');

const app = express();
app.use(express.json());
app.use('/oversight', require('../src/routes/oversight'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const ANALYST = { id: 'an1', role: 'analyst', status: 'active', council_id: null, email: 'an@t' };
const ETHICS = { id: 'et1', role: 'ethics', status: 'active', council_id: null, email: 'et@t' };
const AUDITOR = { id: 'au1', role: 'auditor', status: 'active', council_id: 'cA', email: 'au@t' };
const DUAL = { id: 'du1', role: 'physician', can_audit: true, status: 'active', council_id: 'cA', email: 'du@t' };
const PHYS = { id: 'p1', role: 'physician', status: 'active', council_id: 'cA', email: 'p@t' };

const D = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const doms = (v) => Object.fromEntries(D.map((d) => [d, v]));

// A scored row (audit_scores / ai_evaluations / shadow_evaluations all share the score columns).
const row = (ple_id, composite, domain, extra = {}) => ({ ple_id, composite_score: composite, ...doms(domain), ...extra });
// The prompt and rubric every shadow row here was scored under, unless a test says otherwise. The
// candidate is a (provider, model_version, prompt_version) group, so the prompt is part of its name.
const PV = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const RV = 'pis7-weights-08b0cb1a';
// A shadow run that failed to hold the JSON contract: no scores at all (shadow_scored_xor_failed).
const failedShadow = (ple_id, extra = {}) => ({
  ple_id, composite_score: null, ...Object.fromEntries(D.map((d) => [d, null])),
  error: 'invalid JSON', stop_reason: 'max_tokens', provider: 'local', model_version: 'qwen-2.5-72b',
  prompt_version: PV, rubric_version: RV, evaluated_at: '2026-08-20T00:00:00Z', ...extra,
});
const shadowRow = (ple_id, composite, domain, extra = {}) => row(ple_id, composite, domain, {
  error: null, provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV, rubric_version: RV,
  evaluated_at: '2026-08-20T00:00:00Z', ...extra,
});

// Wire one table -> rows map into the shared mock. `shadow` may be an array OR a {data,error} result.
// `corpus: {scored, failed}` answers the CORPUS-WIDE contract-rate counts — the head/count queries
// the route issues for the chosen candidate, unscoped by audit status. Defaults mirror `shadow`, so
// suites that don't care about the distinction behave as before.
function tables({ audit = [], ai = [], ples = [], shadow = [], corpus = null, settings = [] }) {
  m.state.resolve = (table, kind, ctx) => {
    if (kind !== 'list') return undefined;
    if (table === 'app_settings') return settings;   // the configured ICC gates; [] = code defaults
    if (table === 'audit_scores') return audit;
    if (table === 'ai_evaluations') return ai;
    if (table === 'ples') return ples;
    if (table === 'shadow_evaluations') {
      // A count-only probe: select('ple_id', {count:'exact', head:true}). `.is('error',null)` is the
      // scored count; `.not('error','is',null)` is the failed count.
      const isCount = (ctx?.selectArgs ?? []).some((a) => a && typeof a === 'object' && a.head);
      if (isCount) {
        const rows = Array.isArray(shadow) ? shadow : (shadow.data ?? []);
        const scored = corpus ? corpus.scored : rows.filter((r) => r.error == null).length;
        const failed = corpus ? corpus.failed : rows.filter((r) => r.error != null).length;
        // Matched on the `error` column specifically: the query is also scoped by prompt_version, which
        // is an .is() when the candidate's prompt_version is null.
        return { data: null, error: null, count: ctx.iss.some(([c]) => c === 'error') ? scored : failed };
      }
      return shadow;
    }
    return undefined;
  };
}

beforeEach(() => { m.reset(); });

// ── The blinding control ─────────────────────────────────────────────────────────────────────────
describe('role guard (blinding control)', () => {
  test('an auditor gets 403 — a second AI score must never reach a blinded rater', async () => {
    m.state.caller = AUDITOR;
    tables({ audit: [row('c1', 80, 4)], ai: [row('c1', 82, 4)], ples: [{ id: 'c1', is_test: false }] });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/shadow/i);
  });

  test('a dual-role physician (can_audit) also gets 403 — they score PLEs blind too', async () => {
    m.state.caller = DUAL;
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(403);
  });

  test('a physician gets 403', async () => {
    m.state.caller = PHYS;
    expect((await auth(request(app).get('/oversight/icc/three-way'))).status).toBe(403);
  });

  test('analyst and ethics are allowed', async () => {
    tables({ audit: [], ai: [], ples: [] });
    for (const caller of [ANALYST, ETHICS]) {
      m.reset(); m.state.caller = caller;
      tables({ audit: [], ai: [], ples: [] });
      expect((await auth(request(app).get('/oversight/icc/three-way'))).status).toBe(200);
    }
  });
});

// ── Comparability: all three arms on the SAME PLEs ───────────────────────────────────────────────
describe('three arms', () => {
  const ples = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, is_test: false }));

  beforeEach(() => {
    m.state.caller = ANALYST;
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5), row('c4', 70, 2), row('c5', 50, 1)],
      ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4), row('c4', 72, 3), row('c5', 55, 2)],
      ples,
      // c5 has a shadow row, but it FAILED — no scores, so it cannot be a comparison subject.
      shadow: [shadowRow('c1', 78, 3), shadowRow('c2', 62, 3), shadowRow('c3', 85, 5), shadowRow('c4', 74, 2), failedShadow('c5')],
    });
  });

  test('all three arms are computed on the same PLE set, with per-arm n', async () => {
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(200);
    const { ai_vs_human, shadow_vs_human, ai_vs_shadow } = r.body.arms;
    for (const armName of [ai_vs_human, shadow_vs_human, ai_vs_shadow]) {
      expect(armName).not.toBeNull();
      expect(armName.n).toBe(4);                       // c5 dropped: its shadow run failed
      expect(armName.overall.n).toBe(4);
      expect(Object.keys(armName.per_domain).sort()).toEqual(D);
    }
    // The AI arm is deliberately restricted to the intersection even though 5 PLEs have ai+human —
    // otherwise the three numbers would not be comparable.
    expect(r.body.coverage.ples_with_ai).toBe(5);
    expect(ai_vs_human.n).toBe(4);
  });

  test('coverage funnel + failed shadow runs are counted, not averaged away', async () => {
    const { coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(coverage).toEqual({
      ples_with_human: 5, ples_with_ai: 5, ples_with_shadow: 4, ples_all_three: 4,
      shadow_failed: 1, shadow_contract_rate: 0.8,
      shadow_scored_corpus: 4, shadow_failed_corpus: 1, shadow_contract_rate_corpus: 0.8,
      shadow_ineligible: 0,
    });
    expect(shadow).toEqual({ available: true, provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV });
  });

  // The corpus contract counts describe the CANDIDATE, and the candidate is a prompt version too. An
  // older addendum's failures are not this one's: unscoped by prompt, the rate below reads 0.45.
  test('the corpus counts are scoped to the candidate\'s prompt_version', async () => {
    const OLD = 'pis7-prompt-59561c29+local-aaaaaaaaaaaa';
    const corpusRows = [
      ...Array.from({ length: 9 }, () => ({ provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV, error: null })),
      { provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV, error: 'invalid JSON' },
      ...Array.from({ length: 10 }, () => ({ provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: OLD, error: 'invalid JSON' })),
    ];
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3)],
      ai: [row('c1', 82, 4), row('c2', 58, 3)],
      ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }],
      shadow: [shadowRow('c1', 78, 4, { evaluated_at: '2026-09-01T00:00:00Z' }), shadowRow('c2', 55, 3, { evaluated_at: '2026-09-01T00:00:00Z' }),
        shadowRow('c1', 70, 3, { prompt_version: OLD, evaluated_at: '2026-08-01T00:00:00Z' })],
    });
    const base = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      const isCount = table === 'shadow_evaluations' && (ctx?.selectArgs ?? []).some((a) => a && typeof a === 'object' && a.head);
      if (!isCount) return base(table, kind, ctx);
      // Honour every filter the route applies: eq (provider, model, prompt), is (error / a null prompt), not.
      const hits = corpusRows.filter((r) => ctx.eqs.every(([c, v]) => r[c] === v)
        && ctx.iss.every(([c, v]) => r[c] === v)
        && ctx.nots.every(([c, op, v]) => op === 'is' && r[c] !== v));
      return { data: null, error: null, count: hits.length };
    };
    const { coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(shadow.prompt_version).toBe(PV);
    expect(coverage.shadow_scored_corpus).toBe(9);
    expect(coverage.shadow_failed_corpus).toBe(1);
    expect(coverage.shadow_contract_rate_corpus).toBe(0.9);
  });

  // REGRESSION (confirmed by two review lenses, 2026-08-24). The cohort figures count only this
  // candidate's runs on PLEs that happen to have been audited. Early in a pilot that is a handful,
  // and if those few happened to succeed the panel would show a flawless contract rate for a model
  // that is failing most of the time. "Can this model hold the PIS-7 JSON contract" is a property of
  // the MODEL, not of the audit backlog — and it is the most disqualifying number on the page.
  test('the contract rate is reported CORPUS-WIDE, not just over audited PLEs', async () => {
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3)],
      ai: [row('c1', 82, 4), row('c2', 58, 3)],
      ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }],
      // Both AUDITED PLEs scored fine...
      shadow: [shadowRow('c1', 78, 4), shadowRow('c2', 55, 3)],
      // ...but across every run this candidate has ever made, 40 of 100 failed the contract.
      corpus: { scored: 60, failed: 40 },
    });
    const { coverage } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(coverage.shadow_contract_rate).toBe(1);            // cohort-scoped: flattering
    expect(coverage.shadow_contract_rate_corpus).toBe(0.6);   // corpus-wide: the truth
    expect(coverage.shadow_failed_corpus).toBe(40);
    expect(coverage.shadow_scored_corpus).toBe(60);
  });

  // REGRESSION (confirmed, 2026-08-24). These selects used to drop `error`, so a transient fault
  // returned a confident 200. The `ples` case is the nastiest: an empty testOf silently inverts the
  // include_test=false default and folds sandbox PLEs into the headline acceptance figure.
  test.each([
    ['audit_scores', 'audit_scores'],
    ['ai_evaluations', 'ai_evaluations'],
    ['ples', 'ples'],
  ])('a db fault on %s surfaces as an error, not as confident wrong numbers', async (_label, failing) => {
    const base = {
      audit: [row('c1', 80, 4)], ai: [row('c1', 82, 4)],
      ples: [{ id: 'c1', is_test: false }], shadow: [],
    };
    tables(base);
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) =>
      (table === failing && kind === 'list')
        ? { data: null, error: { message: 'statement timeout' } }
        : prev(table, kind, ctx);
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.coverage).toBeUndefined();   // no half-computed figures leak out
  });

  test('a failed shadow row never contributes a score to any ICC', async () => {
    // Rebuild with every shadow run failed: nothing to compare, but the failure rate is still reported.
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3)],
      ai: [row('c1', 82, 4), row('c2', 58, 3)],
      ples,
      shadow: [failedShadow('c1'), failedShadow('c2')],
    });
    const { arms, coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(shadow.available).toBe(false);              // no usable candidate scores
    expect(arms.shadow_vs_human).toBeNull();
    expect(arms.ai_vs_shadow).toBeNull();
    expect(coverage.shadow_failed).toBe(2);
    expect(coverage.shadow_contract_rate).toBe(0);     // 0/2 — disqualifying, and it must show
    expect(coverage.ples_with_shadow).toBe(0);
    expect(arms.ai_vs_human.n).toBe(2);                // the Claude arm still degrades to human ∩ ai
  });

  test('shadow_contract_rate reflects the scored/attempted split', async () => {
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5), row('c4', 70, 2)],
      ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4), row('c4', 72, 3)],
      ples,
      shadow: [shadowRow('c1', 78, 3), failedShadow('c2'), failedShadow('c3'), shadowRow('c4', 74, 2)],
    });
    const { arms, coverage } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(coverage.shadow_failed).toBe(2);
    expect(coverage.shadow_contract_rate).toBe(0.5);
    expect(arms.shadow_vs_human.n).toBe(2);
    expect(arms.ai_vs_human.n).toBe(2);
  });
});

// ── ICC(2,1) assumes ONE rating per subject per rater ─────────────────────────────────────────────
test('a multi-auditor PLE contributes ONE pair (the auditor mean), not N', async () => {
  m.state.caller = ANALYST;
  tables({
    // c1 was scored by TWO auditors, deliberately far apart: 60/d=0 and 100/d=4 -> mean 80/d=2.
    audit: [row('c1', 60, 0), row('c1', 100, 4), row('c2', 70, 1), row('c3', 95, 5)],
    // Both models matched that MEAN exactly on every PLE, so perfect agreement (icc 0.999) is only
    // reachable if the route averaged first. Pairing per auditor row instead would give n=4; using
    // either raw auditor score for c1 collapses the ICC to ~0.68-0.72 ("Below target").
    ai: [row('c1', 80, 2), row('c2', 70, 1), row('c3', 95, 5)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: false }],
    shadow: [shadowRow('c1', 80, 2), shadowRow('c2', 70, 1), shadowRow('c3', 95, 5)],
  });
  const { arms, coverage } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
  expect(coverage.ples_with_human).toBe(3);
  for (const armName of ['ai_vs_human', 'shadow_vs_human', 'ai_vs_shadow']) {
    expect(arms[armName].n).toBe(3);              // 3 subjects, not 4 rows
    expect(arms[armName].overall.n).toBe(3);
  }
  expect(arms.ai_vs_human.overall.icc).toBe(0.999);          // proves the auditor MEAN was used
  expect(arms.ai_vs_human.per_domain.d1.icc).toBe(0.999);    // ... per-domain too
  expect(arms.shadow_vs_human.overall.icc).toBe(0.999);
});

// ── The migration is deliberately unapplied on some environments ─────────────────────────────────
describe('missing shadow_evaluations table', () => {
  const base = {
    audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5)],
    ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: false }],
  };

  test.each([
    ['PGRST205 schema cache', { code: 'PGRST205', message: "Could not find the table 'public.shadow_evaluations' in the schema cache" }],
    ['42P01 relation', { code: '42P01', message: 'relation "public.shadow_evaluations" does not exist' }],
    ['no code, message only', { message: 'relation "public.shadow_evaluations" does not exist' }],
    // These two were NOT covered, which is why extracting the predicate into services/agreement.js
    // could quietly drop them without a test noticing. PostgREST returns PGRST106 for a schema that
    // is not exposed, and puts "could not find the table" in `hint` rather than `message`.
    ['PGRST106 schema not exposed', { code: 'PGRST106', message: 'The schema must be one of the following: public' }],
    ['hint carries the reason', { message: 'unknown', hint: "Perhaps you meant the table 'public.ples'. Could not find the table 'public.shadow_evaluations'" }],
  ])('%s -> 200 with shadow.available=false, never a 500', async (_label, error) => {
    m.state.caller = ANALYST;
    tables({ ...base, shadow: { data: null, error } });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(200);
    expect(r.body.shadow).toEqual({ available: false, provider: null, model_version: null, prompt_version: null });
    expect(r.body.arms.shadow_vs_human).toBeNull();
    expect(r.body.arms.ai_vs_shadow).toBeNull();
    expect(r.body.coverage.ples_with_shadow).toBe(0);
    expect(r.body.coverage.shadow_failed).toBe(0);
    expect(r.body.coverage.shadow_contract_rate).toBeNull();
    // The Claude arm still works — it degrades to human ∩ ai, exactly what GET /icc reports.
    expect(r.body.arms.ai_vs_human.n).toBe(3);
    expect(r.body.arms.ai_vs_human.overall).not.toBeNull();
  });

  test('an empty shadow table behaves the same as a missing one', async () => {
    m.state.caller = ANALYST;
    tables({ ...base, shadow: [] });
    const { arms, shadow, coverage } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(shadow.available).toBe(false);
    expect(arms.shadow_vs_human).toBeNull();
    expect(coverage.shadow_contract_rate).toBeNull();
    expect(arms.ai_vs_human.n).toBe(3);
  });

  test('a REAL db error still 500s (only a missing relation is degraded)', async () => {
    m.state.caller = ANALYST;
    tables({ ...base, shadow: { data: null, error: { code: '42501', message: 'permission denied for table shadow_evaluations' } } });
    expect((await auth(request(app).get('/oversight/icc/three-way'))).status).toBe(500);
  });

  test('no audit scores at all -> 200, empty arms, no crash', async () => {
    m.state.caller = ANALYST;
    tables({ audit: [], ai: [], ples: [] });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(200);
    expect(r.body.arms.ai_vs_human).toEqual({ overall: null, per_domain: Object.fromEntries(D.map((d) => [d, null])), n: 0, verdict: null });
    expect(r.body.arms.shadow_vs_human).toBeNull();
    expect(r.body.shadow.available).toBe(false);
  });
});

// ── is_test parity with the existing endpoint ────────────────────────────────────────────────────
describe('is_test filtering matches GET /oversight/icc', () => {
  const wire = () => tables({
    audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5)],
    ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: true }],
    shadow: { data: null, error: { code: 'PGRST205', message: 'Could not find the table in the schema cache' } },
  });

  test('test PLEs are excluded by default and included with ?include_test=true', async () => {
    m.state.caller = ANALYST;
    wire();
    const off = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(off.arms.ai_vs_human.n).toBe(2);
    expect(off.coverage.ples_with_human).toBe(2);

    wire();
    const on = (await auth(request(app).get('/oversight/icc/three-way?include_test=true'))).body;
    expect(on.arms.ai_vs_human.n).toBe(3);
    expect(on.coverage.ples_with_human).toBe(3);
  });

  test('with no shadow corpus the Claude arm equals what GET /icc reports', async () => {
    m.state.caller = ANALYST;
    wire();
    const legacy = (await auth(request(app).get('/oversight/icc'))).body;
    wire();
    const threeWay = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(threeWay.arms.ai_vs_human.n).toBe(legacy.n);
    expect(threeWay.arms.ai_vs_human.overall).toEqual(legacy.overall);
    expect(threeWay.arms.ai_vs_human.per_domain).toEqual(legacy.per_domain);

    wire();
    const legacyT = (await auth(request(app).get('/oversight/icc?include_test=true'))).body;
    wire();
    const threeWayT = (await auth(request(app).get('/oversight/icc/three-way?include_test=true'))).body;
    expect(threeWayT.arms.ai_vs_human.n).toBe(legacyT.n);
    expect(threeWayT.arms.ai_vs_human.overall).toEqual(legacyT.overall);
  });

  test('a test PLE cannot sneak into the shadow arms either', async () => {
    m.state.caller = ANALYST;
    tables({
      audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5)],
      ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4)],
      ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: true }],
      shadow: [shadowRow('c1', 78, 3), shadowRow('c2', 62, 3), failedShadow('c3')],
    });
    const { coverage, arms } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(coverage.ples_with_shadow).toBe(2);
    expect(coverage.shadow_failed).toBe(0);          // c3's failure belongs to a test PLE
    expect(coverage.shadow_contract_rate).toBe(1);
    expect(arms.shadow_vs_human.n).toBe(2);
  });
});

// ── Never pool two candidate models into one arm ─────────────────────────────────────────────────
test('with two candidate models, only the most recent one is used and it is named', async () => {
  m.state.caller = ANALYST;
  tables({
    audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5)],
    ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: false }],
    shadow: [
      // Older candidate, wider coverage — must NOT be pooled in, and must NOT win on row count.
      shadowRow('c1', 40, 1, { model_version: 'llama-3.1-8b', evaluated_at: '2026-07-01T00:00:00Z' }),
      shadowRow('c2', 41, 1, { model_version: 'llama-3.1-8b', evaluated_at: '2026-07-01T00:00:00Z' }),
      shadowRow('c3', 42, 1, { model_version: 'llama-3.1-8b', evaluated_at: '2026-07-01T00:00:00Z' }),
      shadowRow('c1', 79, 4, { model_version: 'qwen-2.5-72b', evaluated_at: '2026-08-20T00:00:00Z' }),
      shadowRow('c2', 61, 3, { model_version: 'qwen-2.5-72b', evaluated_at: '2026-08-20T00:00:00Z' }),
    ],
  });
  const { arms, coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
  expect(shadow).toEqual({ available: true, provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV });
  expect(coverage.ples_with_shadow).toBe(2);       // 2, not 5 — the older candidate is a separate set
  expect(coverage.ples_all_three).toBe(2);
  expect(arms.shadow_vs_human.n).toBe(2);
  expect(arms.ai_vs_human.n).toBe(2);
  expect(coverage.shadow_contract_rate).toBe(1);   // both of the winning candidate's runs are scored
});

// ── The tutor model is never a candidate evaluator (CCME R3) ─────────────────────────────────────
// services/agreement.js picks the Model Lock's candidate from shadow_evaluations. rimpl refuses to
// shadow-score with `local-tutor`, but a row that exists anyway (an older rimpl, a hand insert) must
// not be able to become the candidate — however recent it is — and must be COUNTED, not hidden.
describe('local-tutor shadow rows', () => {
  const base = {
    audit: [row('c1', 80, 4), row('c2', 60, 3), row('c3', 90, 5)],
    ai: [row('c1', 82, 4), row('c2', 58, 3), row('c3', 88, 4)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }, { id: 'c3', is_test: false }],
  };
  const tutorRow = (id, c, d) => shadowRow(id, c, d, { provider: 'local-tutor', model_version: 'qwen-tutor', evaluated_at: '2026-10-14T00:00:00Z' });

  test('a NEWER tutor set never displaces the evaluator candidate, and is counted as ineligible', async () => {
    m.state.caller = ANALYST;
    tables({ ...base, shadow: [
      shadowRow('c1', 79, 4), shadowRow('c2', 61, 3),
      tutorRow('c1', 80, 4), tutorRow('c2', 60, 3), tutorRow('c3', 90, 5),
    ] });
    const { arms, coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(shadow).toEqual({ available: true, provider: 'local', model_version: 'qwen-2.5-72b', prompt_version: PV });
    expect(coverage.ples_with_shadow).toBe(2);
    expect(coverage.shadow_ineligible).toBe(3);
    expect(arms.shadow_vs_human.n).toBe(2);
  });

  test('ONLY tutor rows: no candidate at all, no shadow arms, and the decisive verdict cannot pass', async () => {
    m.state.caller = ANALYST;
    tables({ ...base, shadow: [tutorRow('c1', 80, 4), tutorRow('c2', 60, 3), tutorRow('c3', 90, 5)] });
    const { arms, coverage, shadow } = (await auth(request(app).get('/oversight/icc/three-way'))).body;
    expect(shadow).toEqual({ available: false, provider: null, model_version: null, prompt_version: null });
    expect(arms.shadow_vs_human).toBeNull();
    expect(coverage.shadow_ineligible).toBe(3);

    // The Model Lock asks the same question through the same code.
    const { decisiveVerdict } = require('../src/services/agreement');
    const gate = await decisiveVerdict({});
    expect(gate.ok).toBe(true);
    expect(gate.candidate).toBeNull();
    expect(gate.verdict.state).not.toBe('pass');
  });
});

// ── The generalized statistic ────────────────────────────────────────────────────────────────────
describe('iccTwoRater', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({ ai: 60 + i * 1.7, human: 61 + i * 1.6 }));

  test('{a,b} gives byte-identical results to the legacy {ai,human} shape', () => {
    expect(iccTwoRater(pairs.map((p) => ({ a: p.ai, b: p.human })))).toEqual(computeICC21(pairs));
  });

  test('is rater-symmetric, so any two raters can be compared', () => {
    expect(iccTwoRater(pairs.map((p) => ({ a: p.human, b: p.ai })))).toEqual(computeICC21(pairs));
  });

  test('a 0 value is not treated as missing', () => {
    const zeroed = [{ a: 0, b: 1 }, { a: 2, b: 3 }, { a: 4, b: 5 }];
    expect(iccTwoRater(zeroed)).toEqual(computeICC21([{ ai: 0, human: 1 }, { ai: 2, human: 3 }, { ai: 4, human: 5 }]));
  });

  test('degenerate + too-few-pairs behaviour is unchanged', () => {
    expect(iccTwoRater([{ a: 1, b: 1 }])).toBeNull();
    expect(iccTwoRater([{ a: 3, b: 3 }, { a: 3, b: 3 }]).interpretation).toMatch(/insufficient variance/i);
  });
});


// A number without a verdict is a judgement the reader has to make, and different readers make it
// differently. These pin the verdict onto the response — most of all the third state, which is what
// stops a threshold being declared met on a sample too small to support it. The boundary arithmetic
// itself lives in tests/icc-verdict.test.js.
describe('agreement verdicts', () => {
  const scored = {
    audit: [row('c1', 80, 4), row('c2', 60, 3)],
    ai: [row('c1', 82, 4), row('c2', 58, 3)],
    ples: [{ id: 'c1', is_test: false }, { id: 'c2', is_test: false }],
    shadow: [shadowRow('c1', 79, 4), shadowRow('c2', 61, 3)],
  };

  test('the two stages are named, so a reader need not know which arm answers which question', async () => {
    m.state.caller = ANALYST;
    tables(scored);
    const r = await auth(request(app).get('/oversight/icc/three-way'));

    // Screening can reject a candidate before a single human rater exists; only the decisive stage
    // can accept one, because the human raters are the reference standard and the incumbent is not.
    expect(r.body.gates.screening.arm).toBe('ai_vs_shadow');
    expect(r.body.gates.decisive.arm).toBe('shadow_vs_human');
  });

  test('every arm carries its own verdict, against the threshold it is judged by', async () => {
    m.state.caller = ANALYST;
    tables(scored);
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    for (const k of ['ai_vs_human', 'shadow_vs_human', 'ai_vs_shadow']) {
      expect(r.body.arms[k].verdict).toMatchObject({ threshold: 0.75, state: expect.any(String) });
    }
  });

  test('two pairs cannot decide anything — insufficient, and NOT a fail', async () => {
    // Reporting this as `fail` would read as evidence against the candidate. There is none yet.
    m.state.caller = ANALYST;
    tables(scored);
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.body.gates.decisive.state).toBe('insufficient');
  });

  test('with no candidate corpus the gates still answer, rather than vanishing', async () => {
    m.state.caller = ANALYST;
    tables({ ...scored, shadow: [] });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.body.arms.shadow_vs_human).toBeNull();
    // The arm degrades to null; the QUESTION does not. "We have not measured this" is an answer.
    expect(r.body.gates.decisive.state).toBe('insufficient');
    expect(r.body.gates.screening.state).toBe('insufficient');
  });

  test('the thresholds are configuration, not literals', async () => {
    m.state.caller = ANALYST;
    tables({ ...scored, settings: [{ key: 'icc_gate_screening', value: 0.6 }, { key: 'icc_gate_decisive', value: 0.85 }] });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.body.gates.screening.threshold).toBe(0.6);
    expect(r.body.gates.decisive.threshold).toBe(0.85);
  });

  test('a nonsense configured threshold falls back to the code default', async () => {
    m.state.caller = ANALYST;
    tables({ ...scored, settings: [{ key: 'icc_gate_decisive', value: 42 }] });
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.body.gates.decisive.threshold).toBe(0.75);
  });

  test('no audit scores at all still answers both gates', async () => {
    m.state.caller = ANALYST;
    tables({});
    const r = await auth(request(app).get('/oversight/icc/three-way'));
    expect(r.status).toBe(200);
    expect(r.body.gates.screening.state).toBe('insufficient');
    expect(r.body.gates.decisive.state).toBe('insufficient');
  });
});
