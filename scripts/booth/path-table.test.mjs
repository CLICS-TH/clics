import test from 'node:test';
import assert from 'node:assert/strict';
import pleGate from '../../backend/src/services/ple-gate.js';
import { treeSha, reviewedTree, medianDomains, tablePlan, recheck, summaryMarkdown } from './path-table.mjs';
import { PATH_GROUPS, verdicts } from './sandbox-verdict.mjs';

const { compositeScore } = pleGate;
const REVIEW = { model: 'claude-opus-5-5', date: '2026-11-02', findings: 'none' };
const tree = (over = {}) => ({ case_id: 'c', version: '1', event_code: 'E', teaser: { th: 'ก', en: 'a' }, banks: { step1: { x: 1 } }, ...over });
const PATHS = { best: 'BBB', mixed: 'BRW', weakest: 'WWW' };
// scripts/booth/sandbox-play.js's PATHS_BY_STEPS[5], which needs the backend's packages to load (its jest suite pins
// the two equal).
const FIVE = { best: 'BBBBB', mixed: 'BRWRR', weakest: 'WWWWW' };
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const every = (v) => Object.fromEntries(DOMAINS.map((d) => [d, v]));

test('the tree hash ignores version, admission, the table and key order, and sees every other byte', () => {
  const base = treeSha(tree());
  assert.equal(treeSha(tree({ version: '2', admission: { safety_review: REVIEW }, path_score_table: { paths: {} } })), base);
  assert.equal(treeSha({ banks: { step1: { x: 1 } }, teaser: { en: 'a', th: 'ก' }, event_code: 'E', case_id: 'c' }), base);
  assert.notEqual(treeSha(tree({ teaser: { th: 'ก', en: 'a ' } })), base);
});

test('a tree unchanged since the commit that first holds its review keeps that review, at its hash', () => {
  const history = [
    { commit: 'aaaaaaaa1', raw: tree({ teaser: { th: 'ข', en: 'b' } }) },
    { commit: 'bbbbbbbb2', raw: tree({ admission: { safety_review: REVIEW } }) },
    { commit: 'cccccccc3', raw: tree({ admission: { safety_review: REVIEW, owner_waiver: { date: '2026-11-03' } } }) },
  ];
  const current = tree({ version: '2', admission: { safety_review: REVIEW, owner_waiver: { date: '2026-11-03' } } });
  assert.deepEqual(reviewedTree(history, current), { tree_sha256: treeSha(history[1].raw), reviewed_commit: 'bbbbbbbb2' });
});

test('a tree edited after its review, a review no commit holds, and no review are each refused', () => {
  const history = [{ commit: 'bbbbbbbb2', raw: tree({ admission: { safety_review: REVIEW } }) }];
  assert.match(reviewedTree(history, tree({ banks: { step1: { x: 2 } }, admission: { safety_review: REVIEW } })).why, /changed its tree since the safety review in bbbbbbbb/);
  assert.match(reviewedTree(history, tree({ admission: { safety_review: { ...REVIEW, date: '2026-11-04' } } })).why, /no commit holds/);
  assert.match(reviewedTree(history, tree()).why, /no safety review/);
});

test('each table entry is the median per domain of its samples, taken domain by domain', () => {
  const samples = [
    { d1: 3, d2: 1, d3: 5, d4: 2, d5: 4, d6: 3, d7: 1 },
    { d1: 4, d2: 5, d3: 2, d4: 2, d5: 4, d6: 1, d7: 2 },
    { d1: 2, d2: 3, d3: 4, d4: 3, d5: 1, d6: 3, d7: 5 },
  ];
  assert.deepEqual(medianDomains(samples), { d1: 3, d2: 3, d3: 4, d4: 2, d5: 4, d6: 3, d7: 2 });
  assert.throws(() => medianDomains(samples.slice(0, 2)), /odd number/);
});

// Five cases alike, so the pool medians are 60, 50 and 40, and the bands with 3 samples are about 8.
const alike = (best, mixed, weakest) => ({ BBB: best, BRW: mixed, WWW: weakest, BBR: [1, 1, 1] });
const POOL = Object.fromEntries(['p1', 'p2', 'p3', 'p4'].map((id) => [id, alike([60, 60, 60], [50, 50, 50], [40, 40, 40])]));
const THREE = tablePlan(3, PATHS);
// Cases as a three-step build hands them to the re-check, which reads only their sample composites.
const sampleRuns = (byCase) => Object.fromEntries(Object.entries(byCase).map(([id, composites]) => [id, { composites, table: null }]));

test('the re-check passes a case like its pool, judged on the best, mixed and weakest paths\' samples', () => {
  const v = recheck(THREE, sampleRuns({ ...POOL, ok: alike([62, 58, 61], [51, 49, 50], [41, 39, 40]) }), { samples: 3 });
  assert.equal(v.cases.ok.pass, true);
  assert.deepEqual(v.cases.ok.means, { best: 60.33, mixed: 50, weakest: 40 });
});

test('the re-check fails a case whose best path scores no higher than its weakest, and says why', () => {
  const v = recheck(THREE, sampleRuns({ ...POOL, flat: alike([45, 46, 44], [45, 45, 45], [45, 44, 46]) }), { samples: 3 });
  assert.equal(v.cases.flat.pass, false);
  assert.ok(v.cases.flat.reasons.some((r) => /best is only 0 above weakest/.test(r)), v.cases.flat.reasons.join('; '));
});

test('the summary lists each case\'s table and path scores, and names every failing case for a waiver or a switch-off', () => {
  const composites = { ...POOL, flat: alike([45, 46, 44], [45, 45, 45], [45, 44, 46]) };
  const built = (id) => ({ version: '2', tree_sha256: 'f'.repeat(64), reviewed_commit: 'abcdef1234', table: true, composites: { BBB: 60, BRW: 50, WWW: id === 'flat' ? 45 : 40 } });
  const md = summaryMarkdown({
    run_id: 'ptb-1', date: '2026-11-04', scored: 15, planned: 15, spent_usd: 1.5, cap_usd: 25, samples: 3,
    evaluator: { model: 'claude-sonnet-4-6', provider: 'anthropic', prompt_version: 'pis7-prompt-59561c29' },
    method: 'median', scripted: PATHS, sampled: ['BBB', 'BRW', 'WWW'],
    cases: { ...Object.fromEntries(Object.keys(composites).map((id) => [id, built(id)])), gone: { version: '1', why: 'has uncommitted changes', table: false } },
    recheck: recheck(THREE, sampleRuns(composites), { samples: 3 }),
  });
  assert.match(md, /\| gone \| 1 \| refused: has uncommitted changes \| none \| not run \|/);
  assert.match(md, /\| flat \| 2 \| ffffffffffff \(review abcdef12\) \| built \| FAIL \|/);
  assert.match(md, /- flat: .*best is only 0 above weakest/);
  assert.match(md, /left out until the owner waives it again against run ptb-1, or to switch it off: `admission.table_waiver` with `run_id` ptb-1/);
  assert.match(md, /\| WWW \| 40 \| 40 \| 40 \| 40 \| 45 \|/);
});

test('the three-step plan samples all 27 tier paths and makes each entry the median per domain, with its composite', () => {
  const plan = tablePlan(3, PATHS);
  assert.equal(plan.method, 'median');
  assert.equal(new Set(plan.sampled).size, 27);
  assert.ok(plan.sampled.every((p) => /^[BRW]{3}$/.test(p)));
  const brw = [
    { d1: 3, d2: 1, d3: 5, d4: 2, d5: 4, d6: 3, d7: 1 },
    { d1: 4, d2: 5, d3: 2, d4: 2, d5: 4, d6: 1, d7: 2 },
    { d1: 2, d2: 3, d3: 4, d4: 3, d5: 1, d6: 3, d7: 5 },
  ];
  const samplesOf = (p) => (p === 'BRW' ? brw : [every(1), every(4), every(2)]);
  const { paths, composites } = plan.build(samplesOf);
  assert.deepEqual(paths.BRW, { d1: 3, d2: 3, d3: 4, d4: 2, d5: 4, d6: 3, d7: 2 });
  assert.equal(composites.BRW, 61, '20 × (0.15·3 + 0.2·3 + 0.15·4 + 0.15·2 + 0.15·4 + 0.1·3 + 0.1·2)');
  for (const p of plan.sampled) {
    assert.deepEqual(paths[p], medianDomains(samplesOf(p)), p);
    assert.equal(composites[p], compositeScore(paths[p]), p);
  }
});

test('a case length with no table method is refused', () => {
  assert.throws(() => tablePlan(4, {}), /no path score table method for 4-step cases, only 3 and 5/);
});

// Every domain alike: 4, less 0.2 for R and 0.5 for W at each step, except where `step3` says how step 3 moves it.
const fiveStepModel = (step3) => (p) => [...p].reduce((acc, t, s) => acc + (t === 'B' ? 0 : s === 2 ? step3[t] : { R: -0.2, W: -0.5 }[t]), 4);
const around = (model, a = 0.3) => (p) => [-a, 0, a].map((x) => every(model(p) + x));

test('the five-step plan fills all 243 paths from its 27, each domain within 1 to 5 at one decimal, each composite whole, extremes clamped', () => {
  const plan = tablePlan(5, FIVE);
  assert.equal(plan.method, 'median-regression');
  assert.equal(plan.sampled.length, 27);
  for (const p of Object.values(FIVE)) assert.ok(plan.sampled.includes(p), `samples ${p}`);
  // 5.6 at B…B, 1 less per W and 0.5 less per R, 0.1 more per domain from d1 to d7: past 5 at the top, under 1 at
  // W…W, and composites that are not whole before rounding.
  const model = (p, i) => [...p].reduce((acc, t) => acc - { B: 0, R: 0.5, W: 1 }[t], 5.6) + 0.1 * i;
  const samplesOf = (p) => [-0.2, 0, 0.2].map((x) => Object.fromEntries(DOMAINS.map((d, i) => [d, model(p, i) + x])));
  const { paths, composites } = plan.build(samplesOf);
  assert.equal(Object.keys(paths).length, 243);
  assert.ok(Object.keys(paths).every((p) => /^[BRW]{5}$/.test(p)));
  for (const [p, domains] of Object.entries(paths)) {
    for (const v of Object.values(domains)) {
      assert.ok(v >= 1 && v <= 5 && Math.round(v * 10) / 10 === v, `${p}: ${v}`);
    }
    assert.ok(Number.isInteger(composites[p]), `${p} composite ${composites[p]}`);
  }
  assert.deepEqual(paths.BBBBB, every(5));
  assert.deepEqual(paths.WWWWW, { d1: 1, d2: 1, d3: 1, d4: 1, d5: 1, d6: 1.1, d7: 1.2 });
  assert.ok(!plan.sampled.includes('WRBBB'));
  assert.deepEqual(paths.WRBBB, { d1: 4.1, d2: 4.2, d3: 4.3, d4: 4.4, d5: 4.5, d6: 4.6, d7: 4.7 }, 'an unsampled path, 5.6 − 1 − 0.5');
  // 20 × (0.15 + 0.2 + 0.15 · 3 + 0.1 · 1.1 + 0.1 · 1.2) = 20.6, and 3 · 4.1 + 4 · 4.2 + 3 · 4.3 + 3 · 4.4 + 3 · 4.5 + 2 · 4.6 + 2 · 4.7 = 87.3.
  assert.deepEqual([composites.BBBBB, composites.WRBBB, composites.WWWWW], [100, 87, 21]);
});

// A case as a five-step build hands it to the re-check: its sample composites per sampled path and its fitted table.
const asBuilt = (plan, samplesOf) => ({
  composites: Object.fromEntries(plan.sampled.map((p) => [p, samplesOf(p).map(compositeScore)])),
  table: plan.build(samplesOf),
});
// Every domain alike: `base`, less `r` per R step and `w` per W step.
const additive = (base, r, w) => (p) => [...p].reduce((acc, t) => acc - { B: 0, R: r, W: w }[t], base);

test('the five-step re-check judges each scripted path\'s fitted entry: a case like its pool passes and a flat one fails', () => {
  const plan = tablePlan(5, FIVE);
  const pool = Object.fromEntries(['p1', 'p2', 'p3', 'p4'].map((id) => [id, asBuilt(plan, around(additive(4, 0.2, 0.5)))]));
  const v = recheck(plan, {
    ...pool, ok: asBuilt(plan, around(additive(4.1, 0.2, 0.5))), flat: asBuilt(plan, around(additive(4, 0, 0))),
  }, { samples: 3 });
  // B…B 4, BRWRR 4 − 3 × 0.2 − 0.5 = 2.9 and W…W 4 − 5 × 0.5 = 1.5 on every domain: entries of 80, 58 and 30.
  assert.deepEqual(v.cases.p1.means, { best: 80, mixed: 58, weakest: 30 });
  assert.deepEqual(v.cases.ok.means, { best: 82, mixed: 60, weakest: 32 });
  assert.equal(v.cases.ok.pass, true);
  assert.deepEqual(v.cases.flat.means, { best: 80, mixed: 80, weakest: 80 });
  assert.equal(v.cases.flat.pass, false);
  assert.ok(v.cases.flat.reasons.some((r) => /best is only 0 above weakest/.test(r)), v.cases.flat.reasons.join('; '));
});

test('a five-step case whose scripted samples would pass but whose fitted entries are flat fails the re-check', () => {
  const plan = tablePlan(5, FIVE);
  // Every sample of odd scores 3 on every domain but one best sample at 5 and one weakest at 0. Its scripted paths'
  // sample composites average 73.33, 60 and 40, close to the pool's 74, 62 and 44. But every path's median is 3, and
  // a flat table meets every median, so its fitted best, mixed and weakest are all 60.
  const odd = (p) => [3, 3, { [FIVE.best]: 5, [FIVE.weakest]: 0 }[p] ?? 3].map(every);
  const cases = {
    ...Object.fromEntries(['p1', 'p2', 'p3', 'p4'].map((id) => [id, asBuilt(plan, around(additive(3.7, 0.1, 0.3)))])),
    odd: asBuilt(plan, odd),
  };
  const onSamples = verdicts(Object.fromEntries(Object.entries(cases).map(([id, c]) => [id,
    Object.fromEntries(PATH_GROUPS.map((g) => [g, c.composites[FIVE[g]]]))])), PATH_GROUPS, { runs: { best: 3, mixed: 3, weakest: 3 } });
  assert.equal(onSamples.cases.odd.pass, true, onSamples.cases.odd.reasons.join('; '));
  const v = recheck(plan, cases, { samples: 3 });
  assert.deepEqual(v.cases.odd.means, { best: 60, mixed: 60, weakest: 60 });
  assert.equal(v.cases.odd.pass, false);
  assert.ok(v.cases.odd.reasons.some((r) => /best is only 0 above weakest/.test(r)), v.cases.odd.reasons.join('; '));
});

const RUN = {
  run_id: 'ptb-5', date: '2026-11-10', scored: 81, planned: 81, spent_usd: 1.4, cap_usd: 25, samples: 3,
  evaluator: { model: 'claude-sonnet-4-6', provider: 'anthropic', prompt_version: 'pis7-prompt-59561c29' },
};

function fiveStepSummary(step3) {
  const plan = tablePlan(5, FIVE);
  const five = asBuilt(plan, around(fiveStepModel(step3)));
  const pool = Object.fromEntries(['p1', 'p2'].map((id) => [id, asBuilt(plan, around(additive(4, 0.2, 0.5)))]));
  return summaryMarkdown({
    ...RUN, method: plan.method, scripted: FIVE, sampled: plan.sampled,
    cases: { five: { version: '2', tree_sha256: 'f'.repeat(64), reviewed_commit: 'abcdef1234', table: true, composites: five.table.composites, mislabels: five.table.mislabels } },
    recheck: recheck(plan, { ...pool, five }, { samples: 3 }),
  });
}

test('a five-step summary names its method, lists its 27 sampled paths of the 243, and shows a step whose weaker answers beat its best', () => {
  const md = fiveStepSummary({ R: 0.2, W: 0.4 });
  assert.match(md, /3 samples per path of a balanced 27-path design, a median \(L1\) regression of each domain on step × tier filling all 243 paths, domains clamped to 1–5 at one decimal, whole-number composite\. 1 of 1 cases have a table\./);
  assert.match(md, /## Likely tier mislabels\n[^#]*\n- five step 3: weaker beats best by 8 points\n/);
  assert.doesNotMatch(md, /step [1245]: weaker/);
  assert.match(md, /These are the 27 sampled paths; the JSON report holds all 243\./);
  assert.equal(md.match(/^\| [BRW]{5} \| \d+ \|$/gm).length, 27);
  assert.match(md, /\| BRWRR \| 76 \|/, '20 × (4 − 0.2 + 0.4 − 0.2 − 0.2) on every domain');
});

test('a five-step summary says its re-check groups are the fitted entries, judged as the mean of 3 plays, and why that is close', () => {
  const md = fiveStepSummary({ R: 0.2, W: 0.4 });
  assert.match(md, /Each group is the fitted table's entry for its tier path \(best BBBBB, mixed BRWRR, weakest WWWWW\): the whole composite a play on that path scores, not the path's sample composites\. Each entry is judged as the mean of 3 plays against this run's pool/);
  // (π/2)(11/81) = 0.213 and (π/2)(30/81) = 0.582.
  assert.match(md, /draws on all 81 of the case's samples, so it is steadier than a 3-play mean\. One entry's noise is about 0\.21σ², not σ²\/3, so the bands are a little lenient\. Best − weakest's is about 0\.58σ², not 2σ²\/3, so the gap is a little strict\./);
  assert.doesNotMatch(md, /sample composites \(best/);
  // B…B 4, BRWRR 3.8 and W…W 4 − 4 × 0.5 + 0.4 = 2.4 on every domain: one entry each, so no ± spread.
  assert.match(md, /^\| five \| 80 \| 76 \| 48 \| 32 \| FAIL \|$/m);
});

test('a five-step summary with no reversed step says so, and a three-step summary has no mislabel section', () => {
  assert.match(fiveStepSummary({ R: -0.2, W: -0.5 }), /## Likely tier mislabels\n\n.*\n\nNo step's weaker answers score above its best\.\n/);
  const three = summaryMarkdown({
    ...RUN, method: 'median', scripted: PATHS, sampled: ['BBB', 'BRW', 'WWW'],
    cases: { c: { version: '2', tree_sha256: 'f'.repeat(64), reviewed_commit: 'abcdef1234', table: true, composites: { BBB: 60, BRW: 50, WWW: 40 } } },
    recheck: recheck(THREE, sampleRuns({ c: { BBB: [60, 60, 60], BRW: [50, 50, 50], WWW: [40, 40, 40] } }), { samples: 3 }),
  });
  assert.match(three, /3 samples per tier path, median per domain\. 1 of 1 cases have a table\./);
  assert.match(three, /3 sample composites \(best BBB, mixed BRW, weakest WWW\), judged/);
  assert.doesNotMatch(three, /Likely tier mislabels|JSON report holds/);
});
