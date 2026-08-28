// GET /oversight/rater-spread — can the raters discriminate at all?
//
// The corpus that motivated this endpoint is reproduced verbatim below: the five real CLEs as they
// stood on 2026-08-28, which yielded ICC = -0.315. The point of the tests is that this endpoint says
// WHY, in a form somebody can act on, where the ICC alone says only that something is wrong.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/oversight', require('../src/routes/oversight'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const ANALYST = { id: 'an1', role: 'analyst', status: 'active', council_id: null, email: 'an@t' };
const ETHICS = { id: 'et1', role: 'ethics', status: 'active', council_id: null, email: 'et@t' };
const AUDITOR = { id: 'au1', role: 'auditor', status: 'active', council_id: 'cA', email: 'au@t' };
const PHYS = { id: 'p1', role: 'physician', status: 'active', council_id: 'cA', email: 'p@t' };

const D = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const doms = (v) => Object.fromEntries(D.map((d) => [d, v]));
const score = (cle_id, auditor_id, composite, domain = 4) =>
  ({ cle_id, auditor_id, composite_score: composite, ...doms(domain), scored_at: '2026-08-01T00:00:00Z' });

function tables({ audit = [], ai = [], cles = [] }) {
  m.state.resolve = (table, kind) => {
    if (kind !== 'list') return undefined;
    if (table === 'audit_scores') return audit;
    if (table === 'ai_evaluations') return ai;
    if (table === 'cles') return cles;
    return undefined;
  };
}

beforeEach(() => { m.reset(); m.state.caller = ANALYST; });

const get = (q = '') => auth(request(app).get(`/oversight/rater-spread${q}`));

// The real corpus, 2026-08-28. Humans 74-80, AI 71-91.
const REAL = {
  cles: ['c2', 'c5', 'c6', 'c11', 'c12'].map((id) => ({ id, is_test: false })),
  audit: [
    score('c2', 'a1', 75), score('c5', 'a1', 75),
    score('c6', 'a1', 72), score('c6', 'a2', 76),       // 2 raters -> mean 74
    score('c11', 'a1', 80),
    score('c12', 'a1', 76), score('c12', 'a2', 79),     // 2 raters -> mean 77.5
  ],
  ai: [
    { cle_id: 'c2', composite_score: 71 }, { cle_id: 'c5', composite_score: 91 },
    { cle_id: 'c6', composite_score: 91 }, { cle_id: 'c11', composite_score: 73 },
    { cle_id: 'c12', composite_score: 76 },
  ],
};

describe('the finding it exists to make visible', () => {
  test('reports the human range beside the AI range on the same episodes', async () => {
    tables(REAL);
    const r = await get();
    expect(r.status).toBe(200);
    // THE finding: the AI uses three times the range the humans do, on identical episodes. An ICC
    // alone cannot distinguish this from the two simply disagreeing.
    expect(r.body.comparison_on_shared.human_range).toBe(6);
    expect(r.body.comparison_on_shared.ai_range).toBe(20);
    expect(r.body.comparison_on_shared.ai_sd).toBeGreaterThan(r.body.comparison_on_shared.human_sd * 2);
  });

  test('reports how little of the 0-100 composite is being used', async () => {
    tables(REAL);
    const { body } = await get();
    expect(body.scale_use).toMatchObject({ min: 72, max: 80 });
    expect(body.scale_use.span_pct_of_scale).toBe(8);
  });

  test('turns "spread out more" into a number of score points', async () => {
    tables(REAL);
    const { body } = await get();
    // ICC = var_between / (var_between + var_error), so 0.75 needs var_between >= 3 x var_error.
    // Both terms are measurable: error from the two multi-rated episodes, between from the episode
    // means. The endpoint reports them in score points because that is what an instruction can use.
    expect(body.gate.measurable).toBe(true);
    expect(body.gate.sd_error).toBeGreaterThan(0);
    expect(body.gate.sd_between_required).toBeGreaterThan(body.gate.sd_between_observed);
    expect(body.gate.meets).toBe(false);
  });

  test('a corpus that DOES discriminate meets the requirement', async () => {
    // Same rater agreement, episodes genuinely far apart. The gate flips — which is the check that
    // this reports a property of the corpus and not a constant.
    tables({
      cles: ['w', 'x', 'y', 'z'].map((id) => ({ id, is_test: false })),
      audit: [
        score('w', 'a1', 30), score('w', 'a2', 32),
        score('x', 'a1', 55), score('x', 'a2', 57),
        score('y', 'a1', 78), score('y', 'a2', 80),
        score('z', 'a1', 95), score('z', 'a2', 93),
      ],
    });
    const { body } = await get();
    expect(body.gate.measurable).toBe(true);
    expect(body.gate.meets).toBe(true);
  });
});

describe('what it refuses to claim', () => {
  test('single-rated episodes cannot measure rater error, and it says so instead of reporting zero', async () => {
    // Every episode has one rater. Within-episode disagreement is UNMEASURABLE here; reporting it as
    // 0 would imply perfect agreement and make the spread requirement look satisfied.
    tables({
      cles: ['c1', 'c2'].map((id) => ({ id, is_test: false })),
      audit: [score('c1', 'a1', 70), score('c2', 'a1', 80)],
    });
    const { body } = await get();
    expect(body.gate.measurable).toBe(false);
    expect(body.gate.why).toMatch(/two or more raters/);
    expect(body.gate.sd_error).toBeUndefined();
  });

  test('one episode reports no between-episode spread rather than a spread of zero', async () => {
    tables({ cles: [{ id: 'c1', is_test: false }], audit: [score('c1', 'a1', 70), score('c1', 'a2', 72)] });
    const { body } = await get();
    expect(body.between_episodes.sd).toBeNull();
  });

  test('an empty corpus is an answer, not a crash', async () => {
    tables({ cles: [], audit: [], ai: [] });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, empty: true, n_scores: 0 });
  });

  test('test sessions are excluded by default and included on request', async () => {
    tables({
      cles: [{ id: 'real', is_test: false }, { id: 'sbx', is_test: true }],
      audit: [score('real', 'a1', 70), score('sbx', 'a1', 20)],
    });
    expect((await get()).body.n_scores).toBe(1);
    expect((await get('?include_test=true')).body.n_scores).toBe(2);
  });
});

describe('per-domain collapse', () => {
  test('a domain everyone scores the same is reported as a constant', async () => {
    // A domain contributing no variance cannot help the composite separate episodes, however
    // carefully each rating was made — and it is invisible in a composite-level ICC.
    tables({
      cles: ['c1', 'c2', 'c3'].map((id) => ({ id, is_test: false })),
      audit: [
        { ...score('c1', 'a1', 70), d3: 3, d4: 1 },
        { ...score('c2', 'a1', 80), d3: 3, d4: 4 },
        { ...score('c3', 'a1', 90), d3: 3, d4: 5 },
      ],
    });
    const { body } = await get();
    expect(body.per_domain.d3).toMatchObject({ modal_value: 3, modal_share: 1, distinct: 1, sd: 0 });
    expect(body.per_domain.d4.distinct).toBe(3);
    expect(body.per_domain.d4.sd).toBeGreaterThan(0);
  });
});

describe('anchor clarity — the calibration workshop\'s input', () => {
  test('an ambiguous anchor is reported per domain, apart from a collapsed one', async () => {
    // Two different problems with two different fixes: a domain everyone scores IDENTICALLY is a
    // discrimination problem; a domain everyone calls AMBIGUOUS is a rubric problem. Folding them
    // together would send the workshop after the wrong one.
    tables({
      cles: ['c1', 'c2'].map((id) => ({ id, is_test: false })),
      audit: [
        { ...score('c1', 'a1', 70), d5_anchor: 'ambiguous', d1_anchor: 'clear' },
        { ...score('c2', 'a1', 80), d5_anchor: 'ambiguous', d1_anchor: 'clear' },
      ],
    });
    const { body } = await get();
    expect(body.anchor_clarity.d5).toMatchObject({ answered: 2, ambiguous: 2, ambiguous_share: 1 });
    expect(body.anchor_clarity.d1).toMatchObject({ answered: 2, clear: 2, ambiguous_share: 0 });
  });

  test('rows predating the field are counted as unanswered, never as clear', async () => {
    // Every score in the corpus today predates d*_anchor. Reading those as 'clear' would report a
    // rubric nobody has assessed as one nobody found ambiguous.
    tables({ cles: [{ id: 'c1', is_test: false }], audit: [score('c1', 'a1', 70)] });
    const { body } = await get();
    expect(body.anchor_clarity.d1).toMatchObject({ answered: 0, unanswered: 1, clear: 0, ambiguous_share: null });
  });
});

describe('per auditor', () => {
  test('one rater flattening the scale is distinguishable from everyone doing it', async () => {
    tables({
      cles: ['c1', 'c2', 'c3'].map((id) => ({ id, is_test: false })),
      audit: [
        score('c1', 'flat', 75), score('c2', 'flat', 75), score('c3', 'flat', 75),
        score('c1', 'wide', 50), score('c2', 'wide', 75), score('c3', 'wide', 95),
      ],
    });
    const { body } = await get();
    const flat = body.per_auditor.find((a) => a.auditor_id === 'flat');
    const wide = body.per_auditor.find((a) => a.auditor_id === 'wide');
    expect(flat.sd).toBe(0);
    expect(wide.sd).toBeGreaterThan(20);
  });
});

describe('the access tier', () => {
  test.each([['analyst', ANALYST], ['ethics', ETHICS]])('%s may read it', async (_l, caller) => {
    m.state.caller = caller;
    tables(REAL);
    expect((await get()).status).toBe(200);
  });

  test.each([['auditor', AUDITOR], ['physician', PHYS]])('%s may not', async (_l, caller) => {
    m.state.caller = caller;
    tables(REAL);
    expect((await get()).status).toBe(403);
  });

  test('it exposes no transcript and no rater name', async () => {
    tables(REAL);
    const body = JSON.stringify((await get()).body);
    // These roles never see transcripts (§9.4). A spread is readable from ids alone.
    expect(body).not.toMatch(/messages|transcript|content|email|name/i);
  });
});
