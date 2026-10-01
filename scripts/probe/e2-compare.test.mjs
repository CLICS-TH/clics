// The probe scripts that print agreement must use production's weighted composite and production's
// ICC(A,1) estimator (agreement-stats.mjs). agreement-stats.test.mjs proves the shared module is right;
// THIS file proves the scripts still use it. Until 2026-10 model-agreement.mjs and e2-compare.mjs each
// carried a private iccA1 on an unweighted d1..d7 sum, and repeat-consistency.mjs printed that sum, so
// one run read 0.726 in the probes and 0.735 in the verdict tool. Reverting any one of them to master
// must fail here.
//
// e2-compare is an offline reader, so it runs as the CLI it is, on a committed archived report (scores
// and ids only, never transcript text). model-agreement and repeat-consistency need a live model and
// cannot run in CI, so their SOURCE is guarded instead: they must import the shared module, and must
// not define an ICC or a d1..d7 sum of their own. Σ|Δ| (a sum of |differences| or of ranges) is
// deliberately unweighted and is not matched by these guards.
//   node --test scripts/probe/*.test.mjs        — no packages needed, as on CI's bare checkout
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compositeAgreement } from './agreement-stats.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REPEAT = here('./report/noise-2026-09-03-addendum.json');
const AGREEMENT = here('./report/tuning-agreement-addendum.json');

function e2(...args) {
  return JSON.parse(execFileSync(process.execPath, [here('./e2-compare.mjs'), ...args, '--json'], { encoding: 'utf8' }));
}

test('e2-compare reports the weighted composite through the shared estimator', () => {
  const out = e2('--repeat', REPEAT, '--agreement', AGREEMENT);
  const wc = out.agreement.weighted_composite;
  const expected = compositeAgreement(JSON.parse(readFileSync(AGREEMENT, 'utf8')).rows);

  assert.deepEqual(wc.icc, expected.icc, 'the ICC object, interval included, is the shared one');
  assert.equal(wc.n, expected.n);
  assert.equal(wc.bias_local_minus_cloud, expected.bias);
  // Pinned so a revert cannot pass by changing both sides of the comparison above. On the unweighted
  // d1..d7 sum this same report read 0.726 with no interval.
  assert.deepEqual(wc.icc, { icc: 0.735, lower: 0.354, upper: 0.907, n: 14, interpretation: 'Below target (< 0.75)' });
});

test('keys whose meaning changed were renamed, not reused', () => {
  const out = e2('--repeat', REPEAT, '--agreement', AGREEMENT);
  assert.equal(out.agreement.composite, undefined, 'the old unweighted `composite` block must not come back');
  assert.ok(!('icc_a1' in out.agreement), 'no bare icc_a1');
  for (const r of out.repeats) {
    assert.ok('weighted_composite_range_median' in r);
    assert.ok(!('composite_range_median' in r), 'the unweighted range key must not come back');
  }
});

// A d1..d7 sum written inline: `DOMAINS.reduce((a, d) => a + s[d], 0)` or `… + row.local[domain], 0)`.
// Σ|Δ| never matches: it adds Math.abs(…) or a (max − min) range, not a bare score.
const UNWEIGHTED_SUM = /DOMAINS\.reduce\(\(\w+, \w+\) => \w+ \+ \w+(?:\.\w+)?\[\w+\], 0\)/;
const PRIVATE_ICC = /function iccA1\b|\bMS[RCE]\s*=|\bMS[rce]\s*=/;

for (const script of ['model-agreement.mjs', 'repeat-consistency.mjs', 'e2-compare.mjs', 'compare-sessions.mjs']) {
  test(`${script} computes no composite or ICC of its own`, () => {
    const src = readFileSync(here(`./${script}`), 'utf8');
    assert.match(src, /from '\.\/agreement-stats\.mjs'/, 'must import the shared module');
    assert.doesNotMatch(src, UNWEIGHTED_SUM, 'an inline d1..d7 sum is the unweighted composite production never computes');
    assert.doesNotMatch(src, PRIVATE_ICC, 'agreement must come from production\'s estimator, not a private copy');
  });
}
