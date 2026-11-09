import test from 'node:test';
import assert from 'node:assert/strict';
import { treeSha, reviewedTree, medianDomains, recheck, summaryMarkdown } from './path-table.mjs';

const REVIEW = { model: 'claude-opus-5-5', date: '2026-11-02', findings: 'none' };
const tree = (over = {}) => ({ case_id: 'c', version: '1', event_code: 'E', teaser: { th: 'ก', en: 'a' }, banks: { step1: { x: 1 } }, ...over });
const PATHS = { best: 'BBB', mixed: 'BRW', weakest: 'WWW' };

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

test('the re-check passes a case like its pool, judged on the best, mixed and weakest paths\' samples', () => {
  const v = recheck({ ...POOL, ok: alike([62, 58, 61], [51, 49, 50], [41, 39, 40]) }, PATHS, { samples: 3 });
  assert.equal(v.cases.ok.pass, true);
  assert.deepEqual(v.cases.ok.means, { best: 60.33, mixed: 50, weakest: 40 });
});

test('the re-check fails a case whose best path scores no higher than its weakest, and says why', () => {
  const v = recheck({ ...POOL, flat: alike([45, 46, 44], [45, 45, 45], [45, 44, 46]) }, PATHS, { samples: 3 });
  assert.equal(v.cases.flat.pass, false);
  assert.ok(v.cases.flat.reasons.some((r) => /best is only 0 above weakest/.test(r)), v.cases.flat.reasons.join('; '));
});

test('the summary lists each case\'s table and path scores, and names every failing case for a waiver or a switch-off', () => {
  const composites = { ...POOL, flat: alike([45, 46, 44], [45, 45, 45], [45, 44, 46]) };
  const built = (id) => ({ version: '2', tree_sha256: 'f'.repeat(64), reviewed_commit: 'abcdef1234', table: true, composites: { BBB: 60, BRW: 50, WWW: id === 'flat' ? 45 : 40 } });
  const md = summaryMarkdown({
    run_id: 'ptb-1', date: '2026-11-04', scored: 15, planned: 15, spent_usd: 1.5, cap_usd: 25, samples: 3,
    evaluator: { model: 'claude-sonnet-4-6', provider: 'anthropic', prompt_version: 'pis7-prompt-59561c29' },
    cases: { ...Object.fromEntries(Object.keys(composites).map((id) => [id, built(id)])), gone: { version: '1', why: 'has uncommitted changes', table: false } },
    recheck: recheck(composites, PATHS, { samples: 3 }),
  });
  assert.match(md, /\| gone \| 1 \| refused: has uncommitted changes \| none \| not run \|/);
  assert.match(md, /\| flat \| 2 \| ffffffffffff \(review abcdef12\) \| built \| FAIL \|/);
  assert.match(md, /- flat: .*best is only 0 above weakest/);
  assert.match(md, /left out until the owner waives it again against run ptb-1, or to switch it off: `admission.table_waiver` with `run_id` ptb-1/);
  assert.match(md, /\| WWW \| 40 \| 40 \| 40 \| 40 \| 45 \|/);
});
