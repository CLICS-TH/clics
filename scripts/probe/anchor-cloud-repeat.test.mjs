// Tests for anchor-cloud-repeat.mjs's spend cap and spread summary. The cap is the part that spends
// real money if it is wrong, so it is pinned at the worst case: an anchor starts only when K calls at the
// full max_tokens ceiling still fit. Package-free (CI's probe job has no npm install). Run with:
//   node --test scripts/probe/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd, worstCallUsd, canStartAnchor, chargeFor, wilson, spreadSummary, poolReports, INPUT_MARGIN } from './anchor-cloud-repeat.mjs';

const P = { pin: 2, pout: 10 };

test('worst call = counted input with margin + the whole max_tokens ceiling, per MILLION tokens', () => {
  assert.equal(INPUT_MARGIN, 1.1);
  // 10000 input → 11000 × $2/M = 0.022; 16000 output × $10/M = 0.16
  assert.equal(Math.round(worstCallUsd({ inputTokens: 10000, maxTokens: 16000, ...P }) * 1e6) / 1e6, 0.182);
});

test('an anchor starts only if ALL K calls at their worst case still fit under the cap', () => {
  const worstCall = 0.182;
  assert.equal(canStartAnchor({ spent: 0, worstCall, repeats: 2, maxUsd: 0.364 }), true);    // exactly fits
  assert.equal(canStartAnchor({ spent: 0.0001, worstCall, repeats: 2, maxUsd: 0.364 }), false);
  assert.equal(canStartAnchor({ spent: 0.3, worstCall, repeats: 2, maxUsd: 0.7 }), true);
  assert.equal(canStartAnchor({ spent: 0.34, worstCall, repeats: 2, maxUsd: 0.7 }), false);
});

test('a call is charged its reported usage; no usage (timeout/network) is charged the worst case', () => {
  const worstCall = 0.182;
  assert.equal(chargeFor({ usage: { input_tokens: 10000, output_tokens: 4000 } }, { worstCall, ...P }), usd(10000, 4000, 2, 10));
  assert.equal(chargeFor({ usage: null, error: 'timeout 300000ms' }, { worstCall, ...P }), worstCall);
  assert.equal(chargeFor({ usage: null, httpStatus: 529, errorBody: 'overloaded_error' }, { worstCall, ...P }), 0);
  // cache tokens, should they ever appear, are counted at the full input price (overstates, never under)
  assert.equal(chargeFor({ usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900 } }, { worstCall, ...P }), usd(1000, 0, 2, 10));
});

test('wilson bounds', () => {
  const w = wilson(7, 7);
  assert.equal(w.p, 1);
  assert.ok(w.lo > 0.6 && w.lo < 0.7 && w.hi === 1);
  assert.equal(wilson(0, 0).p, null);
});

test('spread: per-domain exact agreement over K runs and composite ranges', () => {
  const s = (o) => ({ scores: { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, ...o }, composite: 60 });
  const rows = [
    { id: 'a', target_composite: 60, scored: [s({}), s({})] },
    { id: 'b', target_composite: 40, scored: [{ ...s({ d4: 1 }), composite: 50 }, { ...s({ d4: 3 }), composite: 58 }] },
    { id: 'c', target_composite: 90, scored: [s({})] },   // one scored run: no spread, not counted
  ];
  const out = spreadSummary(rows);
  assert.equal(out.anchors_with_k_scored, 2);
  assert.deepEqual([out.domain_exact_agreement.k, out.domain_exact_agreement.n], [13, 14]);
  assert.equal(out.domains_differing_by_2plus, 1);
  assert.deepEqual([out.composite_identical.k, out.composite_identical.n], [1, 2]);
  assert.equal(out.composite_range_max, 8);
});

test('pooling refuses two instruments and a duplicated anchor', () => {
  const call = { usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } }, parse: 'ok', stop_reason: 'end_turn', ms: 1, charged_usd: 0.01 };
  const sc = { scores: { d1: 1, d2: 1, d3: 1, d4: 1, d5: 1, d6: 1, d7: 1 }, composite: 20 };
  const rep = (id, prompt = 'p1') => ({ model: 'm', prompt_version: prompt, shape_sent: { thinking: 'adaptive' }, max_tokens: 16000, spent_usd: 0.02,
    anchors: [{ id, target_composite: 20, calls: [call, call], scored: [sc, sc] }] });
  const pooled = poolReports([rep('a'), rep('b')]);
  assert.equal(pooled.anchors, 2);
  assert.equal(pooled.calls, 4);
  assert.equal(pooled.sum_abs_delta.median, 0);
  assert.throws(() => poolReports([rep('a'), rep('b', 'p2')]), /different instruments/);
  assert.throws(() => poolReports([rep('a'), rep('a')]), /more than one report/);
});
