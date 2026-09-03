// services/consistency.js — adaptive self-consistency for the PIS-7 evaluator, tested as the PURE
// function it is: a scripted callOnce, no provider, no route, no env.
//
// What must hold (docs/LOCAL-MODEL-ROADMAP.md D18 / D21):
//   * agree within 1 on every domain → exactly two calls, final = c1, rule first-of-agreeing-pair;
//   * any domain apart by 2+ → a third call, final = per-domain median, rationale from the call
//     closest (L1) to the median, ties → the earliest;
//   * an unparseable reply is re-asked within a budget shared across the run, then Pis7ScoreError;
//   * the physician is billed CALL 1 only; every other call is summed into extra_*;
//   * 'off' is one call and nothing extra;
//   * the consistency block carries integers and fixed-vocabulary strings — never model text.
const { scoreWithConsistency, RULES, METHOD, MODES, AGREE_WITHIN, DEFAULT_AGREE } = require('../src/services/consistency');
const { Pis7ScoreError, compositeOf } = require('../src/lib/pis7');

const V = (d1, d2, d3, d4, d5, d6, d7) => ({ d1, d2, d3, d4, d5, d6, d7 });
const BASE = V(3, 4, 3, 2, 5, 1, 4);
const RATIONALE = 'RATIONALE-SENTINEL quotes the physician verbatim';

// A model reply: valid JSON wrapped in prose, a per-call rationale, distinct token counts per call.
const reply = (scores, tag) => ({
  text: `Here is my assessment:\n${JSON.stringify({ ...scores, rationale: { d1: `${RATIONALE} #${tag}` } })}\nDone.`,
  inputTokens: 1000 + tag, outputTokens: 100 + tag,
});
const garbage = (tag) => ({ text: `I cannot score this transcript (#${tag}).`, inputTokens: 900 + tag, outputTokens: 10 + tag });
const outOfRange = (tag) => ({ text: JSON.stringify({ ...BASE, d2: 9, rationale: {} }), inputTokens: 900 + tag, outputTokens: 10 + tag });

// callOnce that hands out `replies` in order and records the callIndex it was given each time.
function scripted(replies) {
  const seen = [];
  const callOnce = jest.fn(async (i) => {
    seen.push(i);
    const r = replies[seen.length - 1];
    if (!r) throw new Error('scripted callOnce ran out of replies');
    return r;
  });
  return { callOnce, seen };
}

const VOCAB = new Set([METHOD, ...MODES, RULES.single, RULES.pair, RULES.median]);
function leaves(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  else out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
describe('mode adaptive — the reconciliation rule', () => {
  test('c1 and c2 agree within 1 on every domain → exactly two calls, final = c1, rule first-of-agreeing-pair', async () => {
    const { callOnce, seen } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 3), 2)]);   // d7 differs by 1
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });

    expect(callOnce).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([0, 1]);
    expect(r.scores).toEqual(BASE);
    expect(r.composite).toBe(compositeOf(BASE));
    expect(r.rationale.d1).toContain('#1');
    expect(r.billed).toEqual({ inputTokens: 1001, outputTokens: 101 });         // call 1 only
    expect(r.consistency).toMatchObject({
      method: METHOD, mode: 'adaptive', rule: RULES.pair, calls: 2, max_delta: 1, json_retries: 0,
      per_call_scores: [[3, 4, 3, 2, 5, 1, 4], [3, 4, 3, 2, 5, 1, 3]],
      extra_input_tokens: 1002, extra_output_tokens: 102,                       // the second call
    });
    expect(typeof r.consistency.latency_ms).toBe('number');
    expect(r.consistency.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('identical calls agree with max_delta 0', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(BASE, 2)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });
    expect(callOnce).toHaveBeenCalledTimes(2);
    expect(r.consistency).toMatchObject({ rule: RULES.pair, max_delta: 0 });
  });

  test(`one domain apart by ${AGREE_WITHIN + 1} → a third call, per-domain median, rationale from the closest call`, async () => {
    const { callOnce, seen } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 2), 2), reply(V(3, 4, 3, 2, 5, 1, 3), 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });

    expect(callOnce).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([0, 1, 2]);
    expect(r.scores).toEqual(V(3, 4, 3, 2, 5, 1, 3));                          // median(4, 2, 3) = 3
    expect(r.composite).toBe(compositeOf(V(3, 4, 3, 2, 5, 1, 3)));
    expect(r.rationale.d1).toContain('#3');                                     // c3 is at L1 distance 0 from the median
    expect(r.billed).toEqual({ inputTokens: 1001, outputTokens: 101 });
    expect(r.consistency).toMatchObject({
      rule: RULES.median, calls: 3, max_delta: 2, json_retries: 0,
      per_call_scores: [[3, 4, 3, 2, 5, 1, 4], [3, 4, 3, 2, 5, 1, 2], [3, 4, 3, 2, 5, 1, 3]],
      extra_input_tokens: 1002 + 1003, extra_output_tokens: 102 + 103,
    });
  });

  test('ties for closest go to the EARLIEST call', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 2), 2), reply(V(3, 4, 3, 2, 5, 1, 2), 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });
    expect(r.scores.d7).toBe(2);                                                // median(4, 2, 2)
    expect(r.rationale.d1).toContain('#2');                                     // c2 and c3 both at distance 0 → c2
  });

  test('the median is per DOMAIN, not per call — the final vector need not equal any single call', async () => {
    const c1 = V(3, 4, 3, 2, 5, 1, 4);
    const c2 = V(5, 4, 3, 2, 5, 1, 2);   // d1 +2, d7 -2
    const c3 = V(3, 2, 3, 2, 5, 1, 2);   // d2 -2, d7 -2
    const { callOnce } = scripted([reply(c1, 1), reply(c2, 2), reply(c3, 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });
    expect(r.scores).toEqual(V(3, 4, 3, 2, 5, 1, 2));                          // d1 med(3,5,3)=3, d2 med(4,4,2)=4, d7 med(4,2,2)=2
    // Distances to the median: c1 = 2, c2 = 2, c3 = 2 → the tie goes to c1.
    expect(r.rationale.d1).toContain('#1');
  });
});

// ---------------------------------------------------------------------------
describe('unparseable replies — the shared re-ask budget', () => {
  test('a garbage reply is re-asked within the budget and counted as json_retries; call 1 is still the billed one', async () => {
    const { callOnce, seen } = scripted([garbage(1), reply(BASE, 2), reply(BASE, 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 2 });
    expect(callOnce).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([0, 1, 2]);                                            // callIndex counts the re-ask
    expect(r.scores).toEqual(BASE);
    expect(r.consistency).toMatchObject({ rule: RULES.pair, calls: 2, json_retries: 1 });
    expect(r.billed).toEqual({ inputTokens: 901, outputTokens: 11 });          // call 1, whatever it returned (D21)
    expect(r.consistency).toMatchObject({ extra_input_tokens: 1002 + 1003, extra_output_tokens: 102 + 103 });
  });

  test('an out-of-range reply is a re-ask too', async () => {
    const { callOnce } = scripted([outOfRange(1), reply(BASE, 2), reply(BASE, 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 2 });
    expect(callOnce).toHaveBeenCalledTimes(3);
    expect(r.consistency.json_retries).toBe(1);
  });

  test('past the budget the Pis7ScoreError propagates — after exactly budget + 1 bad replies', async () => {
    const { callOnce } = scripted([garbage(1), garbage(2), garbage(3), reply(BASE, 4)]);
    await expect(scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 2 })).rejects.toBeInstanceOf(Pis7ScoreError);
    expect(callOnce).toHaveBeenCalledTimes(3);
  });

  test('the budget is shared across the RUN: re-asks spent on c1 are not available again for c2', async () => {
    const { callOnce } = scripted([garbage(1), garbage(2), reply(BASE, 3), garbage(4), reply(BASE, 5)]);
    // c1 used both re-asks; c2's first bad reply has no budget left.
    await expect(scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 2 })).rejects.toBeInstanceOf(Pis7ScoreError);
    expect(callOnce).toHaveBeenCalledTimes(4);
  });

  test('jsonRetries 0: the first bad reply throws at once', async () => {
    const { callOnce } = scripted([garbage(1), reply(BASE, 2)]);
    await expect(scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 0 })).rejects.toBeInstanceOf(Pis7ScoreError);
    expect(callOnce).toHaveBeenCalledTimes(1);
  });

  test('a NON-score error from callOnce (transport, queue, abort) propagates untouched and is never re-asked', async () => {
    const err = Object.assign(new Error('local AI 503 Service Unavailable'), { status: 503 });
    const callOnce = jest.fn().mockRejectedValue(err);
    await expect(scoreWithConsistency({ callOnce, mode: 'adaptive', jsonRetries: 2 })).rejects.toBe(err);
    expect(callOnce).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('mode off — the historical single call', () => {
  test('one call, rule single, nothing extra, max_delta null', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(BASE, 2)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'off' });
    expect(callOnce).toHaveBeenCalledTimes(1);
    expect(r.scores).toEqual(BASE);
    expect(r.billed).toEqual({ inputTokens: 1001, outputTokens: 101 });
    expect(r.consistency).toMatchObject({
      method: METHOD, mode: 'off', rule: RULES.single, calls: 1, max_delta: null, json_retries: 0,
      per_call_scores: [[3, 4, 3, 2, 5, 1, 4]], extra_input_tokens: 0, extra_output_tokens: 0,
    });
  });

  test('off is the default mode', async () => {
    const { callOnce } = scripted([reply(BASE, 1)]);
    const r = await scoreWithConsistency({ callOnce });
    expect(r.consistency.mode).toBe('off');
    expect(callOnce).toHaveBeenCalledTimes(1);
  });

  test('off still honours a re-ask budget when given one (the module is mode-agnostic; the route passes 0 for the incumbent)', async () => {
    const { callOnce } = scripted([garbage(1), reply(BASE, 2)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'off', jsonRetries: 2 });
    expect(callOnce).toHaveBeenCalledTimes(2);
    expect(r.consistency).toMatchObject({ rule: RULES.single, calls: 1, json_retries: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('the consistency block carries no model text', () => {
  test('median-of-3 with rationales that quote a sentinel: the block has fixed keys, integer/null/vocabulary leaves only', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 2), 2), reply(V(3, 4, 3, 2, 5, 1, 3), 3)]);
    const { consistency, rationale } = await scoreWithConsistency({ callOnce, mode: 'adaptive' });

    expect(rationale.d1).toContain('RATIONALE-SENTINEL');                        // the rationale travels beside the block…
    const wire = JSON.stringify(consistency);
    expect(wire).not.toContain('RATIONALE');                                     // …never inside it
    expect(wire).not.toContain('assessment');
    expect(Object.keys(consistency).sort()).toEqual([
      'agree', 'calls', 'extra_input_tokens', 'extra_output_tokens', 'json_retries', 'latency_ms',
      'max_delta', 'method', 'mode', 'per_call_scores', 'rule', 'sum_delta',
    ]);
    expect(Object.keys(consistency.agree).sort()).toEqual(['max_domain_delta', 'max_sum_delta']);
    for (const leaf of leaves(consistency)) {
      if (typeof leaf === 'string') expect(VOCAB.has(leaf)).toBe(true);
      else expect(leaf === null || Number.isInteger(leaf)).toBe(true);
    }
  });

  test('an unknown mode throws before any call; callOnce must be a function', async () => {
    const { callOnce } = scripted([reply(BASE, 1)]);
    await expect(scoreWithConsistency({ callOnce, mode: 'always' })).rejects.toThrow(/Unknown consistency mode "always"/);
    expect(callOnce).not.toHaveBeenCalled();
    await expect(scoreWithConsistency({ mode: 'off' })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The Σ|Δ| knob. On the tuning split 16/16 first pairs "agreed" under max |Δ| ≤ 1, yet repeats of one
// fixture drifted as a near-uniform ±1 level shift across 5–6 domains: max |Δ| = 1, Σ|Δ| = 5–6. The
// D18 repeatability bar is Σ|Δ| median ≤ 2.
describe('agree.maxSumDelta — a uniform level shift', () => {
  const SHIFTED = V(4, 5, 4, 3, 4, 1, 4);   // +1 on d1..d5 vs BASE: max |Δ| 1, Σ|Δ| 5

  test('the defaults are the historical rule: max |Δ| ≤ 1 alone, sum check off', () => {
    expect(DEFAULT_AGREE).toEqual({ maxDomainDelta: 1, maxSumDelta: 0 });
    expect(AGREE_WITHIN).toBe(1);
    expect(MODES).toEqual(['off', 'adaptive', 'median3']);
  });

  test('under the default the shifted pair AGREES: two calls, final = c1, and the block records sum_delta 5 with the thresholds', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(SHIFTED, 2)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive' });
    expect(callOnce).toHaveBeenCalledTimes(2);
    expect(r.scores).toEqual(BASE);
    expect(r.consistency).toMatchObject({
      rule: RULES.pair, calls: 2, max_delta: 1, sum_delta: 5, agree: { max_domain_delta: 1, max_sum_delta: 0 },
    });
  });

  test('with maxSumDelta 2 the same pair DISAGREES: a third call and the per-domain median', async () => {
    const c3 = V(4, 4, 3, 3, 5, 1, 4);
    const { callOnce } = scripted([reply(BASE, 1), reply(SHIFTED, 2), reply(c3, 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive', agree: { maxSumDelta: 2 } });
    expect(callOnce).toHaveBeenCalledTimes(3);
    expect(r.scores).toEqual(V(4, 4, 3, 3, 5, 1, 4));        // per-domain median of BASE / SHIFTED / c3
    expect(r.rationale.d1).toContain('#3');                   // c3 is the median itself
    expect(r.consistency).toMatchObject({
      rule: RULES.median, calls: 3, max_delta: 1, sum_delta: 5, agree: { max_domain_delta: 1, max_sum_delta: 2 },
    });
  });

  test('the sum bound is inclusive: Σ|Δ| 5 agrees at maxSumDelta 5 and not at 4', async () => {
    const a = scripted([reply(BASE, 1), reply(SHIFTED, 2), reply(BASE, 3)]);
    expect((await scoreWithConsistency({ callOnce: a.callOnce, mode: 'adaptive', agree: { maxSumDelta: 5 } })).consistency.rule).toBe(RULES.pair);
    const b = scripted([reply(BASE, 1), reply(SHIFTED, 2), reply(BASE, 3)]);
    expect((await scoreWithConsistency({ callOnce: b.callOnce, mode: 'adaptive', agree: { maxSumDelta: 4 } })).consistency.rule).toBe(RULES.median);
  });

  test('both checks must hold: a pair under the sum bound but over the domain bound still disagrees', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 2), 2), reply(BASE, 3)]);   // d7 -2: Σ|Δ| 2
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive', agree: { maxSumDelta: 6 } });
    expect(r.consistency).toMatchObject({ rule: RULES.median, max_delta: 2, sum_delta: 2 });
  });

  test('maxDomainDelta 0 makes only an identical pair agree', async () => {
    const a = scripted([reply(BASE, 1), reply(BASE, 2)]);
    expect((await scoreWithConsistency({ callOnce: a.callOnce, mode: 'adaptive', agree: { maxDomainDelta: 0 } })).consistency.rule).toBe(RULES.pair);
    const b = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 3), 2), reply(BASE, 3)]);
    expect((await scoreWithConsistency({ callOnce: b.callOnce, mode: 'adaptive', agree: { maxDomainDelta: 0 } })).consistency.rule).toBe(RULES.median);
  });

  test('a partial agree keeps the other default; an undefined key keeps the default too', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(BASE, 2)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'adaptive', agree: { maxSumDelta: 2, maxDomainDelta: undefined } });
    expect(r.consistency.agree).toEqual({ max_domain_delta: 1, max_sum_delta: 2 });
  });

  test.each([
    ['a negative sum bound', { maxSumDelta: -1 }],
    ['a fractional domain bound', { maxDomainDelta: 0.5 }],
    ['a NaN (an unparsed env value)', { maxSumDelta: NaN }],
    ['a string', { maxSumDelta: '2' }],
  ])('%s is refused before any call', async (_label, agree) => {
    const { callOnce } = scripted([reply(BASE, 1)]);
    await expect(scoreWithConsistency({ callOnce, mode: 'adaptive', agree })).rejects.toThrow(/agree\.max(Domain|Sum)Delta must be an integer >= 0/);
    expect(callOnce).not.toHaveBeenCalled();
  });

  test('the thresholds are recorded in every mode; off carries null deltas', async () => {
    const { callOnce } = scripted([reply(BASE, 1)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'off', agree: { maxSumDelta: 2 } });
    expect(r.consistency).toMatchObject({ rule: RULES.single, max_delta: null, sum_delta: null, agree: { max_domain_delta: 1, max_sum_delta: 2 } });
  });
});

// ---------------------------------------------------------------------------
describe('mode median3 — always three calls', () => {
  test('c1 = c2 = c3 still makes three calls: rule median-of-3, deltas 0, same block shape', async () => {
    const { callOnce, seen } = scripted([reply(BASE, 1), reply(BASE, 2), reply(BASE, 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'median3' });
    expect(callOnce).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([0, 1, 2]);
    expect(r.scores).toEqual(BASE);
    expect(r.rationale.d1).toContain('#1');                                  // all at distance 0 → earliest
    expect(r.billed).toEqual({ inputTokens: 1001, outputTokens: 101 });     // call 1 only, as in every mode
    expect(r.consistency).toMatchObject({
      mode: 'median3', rule: RULES.median, calls: 3, max_delta: 0, sum_delta: 0,
      agree: { max_domain_delta: 1, max_sum_delta: 0 }, extra_input_tokens: 1002 + 1003, extra_output_tokens: 102 + 103,
    });
    expect(Object.keys(r.consistency).sort()).toEqual([
      'agree', 'calls', 'extra_input_tokens', 'extra_output_tokens', 'json_retries', 'latency_ms',
      'max_delta', 'method', 'mode', 'per_call_scores', 'rule', 'sum_delta',
    ]);
  });

  test('a disagreeing triple takes the per-domain median exactly as adaptive would', async () => {
    const { callOnce } = scripted([reply(BASE, 1), reply(V(3, 4, 3, 2, 5, 1, 2), 2), reply(V(3, 4, 3, 2, 5, 1, 3), 3)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'median3' });
    expect(r.scores.d7).toBe(3);
    expect(r.rationale.d1).toContain('#3');
    expect(r.consistency).toMatchObject({ rule: RULES.median, max_delta: 2, sum_delta: 2 });
  });

  test('re-asks apply in median3 too, within the shared budget', async () => {
    const { callOnce } = scripted([reply(BASE, 1), garbage(2), reply(BASE, 3), reply(BASE, 4)]);
    const r = await scoreWithConsistency({ callOnce, mode: 'median3', jsonRetries: 2 });
    expect(callOnce).toHaveBeenCalledTimes(4);
    expect(r.consistency).toMatchObject({ calls: 3, json_retries: 1 });
  });
});
