// The candidate is a (provider, model_version, prompt_version) group — never a pool of prompt addenda.
//
// The local evaluator's prompt carries an addendum (`pis7-prompt-<base>+local-<addendum>`), and the
// addendum has been rewritten mid-programme. Before this, rows scored under two addenda were one
// "candidate", so the decisive ICC the Model Lock gates on could be earned partly by a prompt that no
// longer ships. These pin the split, the lock's ability to ask for the DECLARED prompt's own verdict,
// and that the oversight screen names the prompt it is showing.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { pairedSets, decisiveVerdict } = require('../src/services/agreement');
const { iccTwoRater } = require('../src/services/icc');

const D = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const doms = (v) => Object.fromEntries(D.map((d) => [d, v]));
const row = (ple_id, composite, domain, extra = {}) => ({ ple_id, composite_score: composite, ...doms(domain), ...extra });

const OLD = 'pis7-prompt-59561c29+local-aaaaaaaaaaaa';
const NEW = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const RV = 'pis7-weights-08b0cb1a';
const shadow = (ple_id, composite, domain, prompt_version, extra = {}) => row(ple_id, composite, domain, {
  error: null, provider: 'local', model_version: 'CCME_LLM_v8.0+qwen', prompt_version, rubric_version: RV,
  evaluated_at: prompt_version === NEW ? '2026-10-10T00:00:00Z' : '2026-09-01T00:00:00Z', ...extra,
});

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const HUMAN = [40, 55, 62, 70, 81, 90];
// The OLD addendum tracks the humans closely; the NEW one is unrelated to them. Pooled, the two would
// produce a number that describes neither — and a Map keyed by PLE would silently keep whichever row
// came last.
const OLD_SCORES = [41, 54, 63, 71, 80, 89];
const NEW_SCORES = [75, 40, 88, 52, 61, 45];

function corpus({ shadowRows }) {
  m.state.resolve = (table, kind, ctx) => {
    if (kind !== 'list') return undefined;
    if (table === 'app_settings') return [];
    if (table === 'audit_scores') return IDS.map((id, i) => row(id, HUMAN[i], 3));
    if (table === 'ai_evaluations') return IDS.map((id, i) => row(id, HUMAN[i] + 1, 3));
    if (table === 'ples') return IDS.map((id) => ({ id, is_test: false }));
    if (table === 'shadow_evaluations') {
      const isCount = (ctx?.selectArgs ?? []).some((a) => a && typeof a === 'object' && a.head);
      if (isCount) return { data: null, error: null, count: 0 };
      return shadowRows;
    }
    return undefined;
  };
}

const twoAddenda = () => [
  ...IDS.map((id, i) => shadow(id, OLD_SCORES[i], 3, OLD)),
  ...IDS.map((id, i) => shadow(id, NEW_SCORES[i], 3, NEW)),
];
const iccOf = (scores) => iccTwoRater(scores.map((s, i) => ({ a: s, b: HUMAN[i] })));

beforeEach(() => { m.reset(); });

describe('two prompt addenda are two candidates', () => {
  test('they are separate groups, and the most recent one is the default candidate', async () => {
    corpus({ shadowRows: twoAddenda() });
    const sets = await pairedSets();
    expect(sets.groups.map((g) => [g.prompt_version, g.rows])).toEqual([[NEW, 6], [OLD, 6]]);
    expect(sets.candidate.prompt_version).toBe(NEW);
    // Every score in the arm is from the NEW addendum — none of the OLD one's rows leaked in.
    expect(IDS.map((id) => sets.shadowBy.get(id).composite_score)).toEqual(NEW_SCORES);
  });

  test('asking for a prompt version gets that group alone', async () => {
    corpus({ shadowRows: twoAddenda() });
    const sets = await pairedSets({ promptVersion: OLD });
    expect(sets.candidate.prompt_version).toBe(OLD);
    expect(IDS.map((id) => sets.shadowBy.get(id).composite_score)).toEqual(OLD_SCORES);
  });

  test('the decisive verdict for a prompt version is computed on that prompt\'s rows only', async () => {
    corpus({ shadowRows: twoAddenda() });
    const oldV = await decisiveVerdict({ promptVersion: OLD });
    const newV = await decisiveVerdict({ promptVersion: NEW });
    expect(oldV.verdict.icc).toBeCloseTo(iccOf(OLD_SCORES).icc, 10);
    expect(newV.verdict.icc).toBeCloseTo(iccOf(NEW_SCORES).icc, 10);
    expect(oldV.verdict.icc).not.toBeCloseTo(newV.verdict.icc, 2);
    expect(oldV.candidate).toEqual({ provider: 'local', model_version: 'CCME_LLM_v8.0+qwen', prompt_version: OLD, rubric_versions: [RV] });
  });

  test('a prompt version nobody scored under has no candidate, so it cannot pass', async () => {
    corpus({ shadowRows: twoAddenda() });
    const v = await decisiveVerdict({ promptVersion: 'pis7-prompt-typo' });
    expect(v.candidate).toBeNull();
    expect(v.verdict.state).toBe('insufficient');
  });

  test('omitting promptVersion keeps the old behaviour: the most recent group decides', async () => {
    corpus({ shadowRows: twoAddenda() });
    const v = await decisiveVerdict({});
    expect(v.candidate.prompt_version).toBe(NEW);
    expect(v.verdict.icc).toBeCloseTo(iccOf(NEW_SCORES).icc, 10);
  });

  test('a row with no prompt_version is its own group, never pooled with a known one', async () => {
    const rows = [
      ...IDS.map((id, i) => shadow(id, OLD_SCORES[i], 3, NEW)),
      ...IDS.map((id, i) => shadow(id, NEW_SCORES[i], 3, undefined, { evaluated_at: '2026-10-11T00:00:00Z' })),
    ];
    corpus({ shadowRows: rows });
    const sets = await pairedSets();
    expect(sets.groups.map((g) => g.prompt_version)).toEqual([null, NEW]);
    expect(sets.candidate.prompt_version).toBeNull();
    expect((await pairedSets({ promptVersion: NEW })).candidate.rows).toHaveLength(6);
  });

  test('the rubric versions a group was scored under are reported, so a mixed group is visible', async () => {
    const rows = IDS.map((id, i) => shadow(id, OLD_SCORES[i], 3, NEW, i < 3 ? {} : { rubric_version: 'pis7-weights-older' }));
    corpus({ shadowRows: rows });
    const v = await decisiveVerdict({ promptVersion: NEW });
    expect(v.candidate.rubric_versions.sort()).toEqual([RV, 'pis7-weights-older'].sort());
  });
});

describe('the oversight screen names the prompt version it shows', () => {
  const app = express();
  app.use(express.json());
  app.use('/oversight', require('../src/routes/oversight'));
  const ANALYST = { id: 'an1', role: 'analyst', status: 'active', council_id: null, email: 'an@t' };

  test('shadow.prompt_version is the candidate\'s, and the corpus contract counts are scoped to it', async () => {
    m.state.caller = ANALYST;
    corpus({ shadowRows: twoAddenda() });
    const r = await request(app).get('/oversight/icc/three-way').set('Authorization', 'Bearer t');
    expect(r.status).toBe(200);
    expect(r.body.shadow).toEqual({ available: true, provider: 'local', model_version: 'CCME_LLM_v8.0+qwen', prompt_version: NEW });
    expect(r.body.arms.shadow_vs_human.n).toBe(6);
    const counts = m.all('shadow_evaluations').filter((q) => (q.selectArgs ?? []).some((a) => a && typeof a === 'object' && a.head));
    expect(counts).toHaveLength(2);
    for (const q of counts) expect(q.eqs).toContainEqual(['prompt_version', NEW]);
  });
});
