// Inter-auditor agreement, per PIS-7 domain.
//
// The composite answers "do our raters rank episodes alike"; it cannot answer "which anchor needs
// rewriting", which is the calibration workshop's actual output. A composite can look acceptable
// while one domain carries all the disagreement, and a domain where every rater picked the same
// value is a fact about the cohort, not agreement — those two must not render as the same thing.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/superadmin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 'sa@test' };
const C = 'council-a';

// Four episodes, two raters each. d1 is unanimous (4 everywhere) — a real pattern: production's
// only human cohort has d1 and d2 at SD 0. d3 is where the raters actually diverge.
const S = (ple, aud, comp, d3) => ({
  ple_id: ple, auditor_id: aud, council_id: C, composite_score: comp,
  d1: 4, d2: 4, d3, d4: 4, d5: 3, d6: 3, d7: 4,
});
const SCORES = [
  S('p1', 'a1', 70, 3), S('p1', 'a2', 74, 5),
  S('p2', 'a1', 50, 2), S('p2', 'a2', 55, 2),
  S('p3', 'a1', 88, 5), S('p3', 'a2', 84, 4),
  S('p4', 'a1', 62, 3), S('p4', 'a2', 66, 4),
];

beforeEach(() => {
  m.reset();
  m.state.caller = SUPER;
  m.state.resolve = (table, kind) => {
    if (table === 'audit_scores') return SCORES;
    if (table === 'ai_evaluations') return ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
      ple_id: id, composite_score: [72, 52, 86, 64][i], d1: 4, d2: 4, d3: 4, d4: 4, d5: 3, d6: 3, d7: 4,
    }));
    if (table === 'ples') return ['p1', 'p2', 'p3', 'p4'].map(id => ({ id, is_test: false }));
    if (table === 'app_settings') return { value: 1 };   // min_auditors_per_cle
    return undefined;
  };
});

test('inter-auditor agreement is reported per domain, not only on the composite', async () => {
  const r = await auth(request(app).get('/superadmin/icc'));
  expect(r.status).toBe(200);

  // The composite figure the cohort already had.
  expect(r.body.inter_auditor.n).toBe(4);
  expect(typeof r.body.inter_auditor.icc).toBe('number');

  const pd = r.body.inter_auditor_per_domain;
  expect(Object.keys(pd)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);

  // d3 is where the raters diverge, so it estimates.
  expect(typeof pd.d3.icc).toBe('number');
  expect(pd.d3.n).toBe(4);

  // d1 is unanimous. That must surface as "no variance to agree about", NOT as an ICC near -1 and
  // NOT as a missing key — a domain nobody disagreed on is a finding, and silently dropping it
  // would hide the flattest domains, which are exactly the ones worth looking at.
  expect(pd.d1.icc).toBeNull();
  expect(pd.d1.interpretation).toMatch(/variance/i);

  // Same estimator as the composite figure, so the two are on one scale and comparable.
  expect(r.body.inter_auditor_note).toMatch(/ICC\(1,1\)/);
});

test('a cohort with no multi-rated episode reports no per-domain figure rather than a fabricated one', async () => {
  m.state.resolve = ((prev) => (table, kind) => {
    if (table === 'audit_scores') return [S('p1', 'a1', 70, 3), S('p2', 'a1', 50, 2)]; // one rater each
    return prev(table, kind);
  })(m.state.resolve);

  const r = await auth(request(app).get('/superadmin/icc'));
  expect(r.status).toBe(200);
  expect(r.body.inter_auditor.icc).toBeNull();
  expect(r.body.inter_auditor.interpretation).toMatch(/no ple has more than one auditor/i);
  for (const d of ['d1', 'd3', 'd7']) expect(r.body.inter_auditor_per_domain[d]).toBeNull();
});
