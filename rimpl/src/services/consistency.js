// Adaptive self-consistency for the PIS-7 evaluator. PURE and injectable: no provider, no env, no
// route — one `callOnce(callIndex)` the caller supplies, and the rule below — so a probe script can
// run the identical rule offline against saved replies.
//
// WHY. On the same fixture, same prompt, temperature 0, the evaluator's Σ|Δ| across sessions was 0–8
// on BOTH models. The D18 screening gate (lower CI >= 0.75 against the incumbent) cannot pass with
// that noise, so the local arm scores two or three times and reconciles:
//
//   adaptive  c1, c2 → the pair AGREES (see DEFAULT_AGREE)  → final = c1     rule 'first-of-agreeing-pair'
//                    → otherwise c3                          → final = per-domain median of the three
//                                                                            rule 'median-of-3'
//             rationale from the call whose score vector is closest (L1) to the median; ties → the
//             earliest call.
//   median3   always three calls, per-domain median, rule 'median-of-3' — no pairwise short-cut.
//   off       one call, rule 'single'.
//
// The rule names, mode names and option keys here are a CONTRACT with scripts/probe/
// repeat-consistency.mjs (--consistency off|adaptive|median3 --agree-sum N), which runs this very
// module against saved replies; MODES is exported so the flag can be validated against it.
//
// D21 attribution: the physician is billed CALL 1 only — the first model call made, whatever it
// returned. Every other call (a consistency call, or a re-ask after an unparseable reply) is
// system-initiated and is summed into `consistency.extra_*` for provenance.
//
// An unparseable / out-of-range reply is re-asked, up to `jsonRetries` times IN TOTAL across the run;
// past the budget the Pis7ScoreError propagates (the route answers 502, as it always has).
//
// NOTHING IN THE RETURNED `consistency` BLOCK IS TEXT FROM THE MODEL: integers, nulls, and strings
// from the fixed vocabulary in this file. The rationale travels beside it, exactly as one call's would.
const { scoreFromText, compositeOf, DOMAIN_KEYS, Pis7ScoreError } = require('../lib/pis7');
// The vocabulary and the default thresholds live in lib/consistency-config.js, package-free, so the model
// manifest records the values this rule runs with. Re-exported below: every caller's import is unchanged.
const { METHOD, MODES, RULES, DEFAULT_AGREE } = require('../lib/consistency-config');

// When does the pair c1/c2 AGREE? (DEFAULT_AGREE)
//   maxDomainDelta  no domain may differ by more than this (the historical rule);
//   maxSumDelta     Σ|Δ| over d1..d7 may not exceed this; 0 = off, i.e. the per-domain check alone.
// Both must hold. WHY the second knob: on the tuning split 16/16 first pairs "agreed" under
// max |Δ| ≤ 1, yet five same-day repeats of one fixture drifted as a near-uniform ±1 level shift
// across 5–6 domains (composites 21/17/15/17/17). A uniform shift has max |Δ| = 1 but Σ|Δ| = 5–6, so
// the per-domain check accepts it and returns c1 — while the D18 repeatability bar is Σ|Δ| median ≤ 2.
// The defaults reproduce the historical behaviour byte for byte.
const AGREE_WITHIN = DEFAULT_AGREE.maxDomainDelta;   // the historical constant, kept for readers of it

const vectorOf = (scores) => DOMAIN_KEYS.map((k) => scores[k]);
const maxDelta = (u, v) => Math.max(...u.map((x, i) => Math.abs(x - v[i])));
const l1 = (u, v) => u.reduce((acc, x, i) => acc + Math.abs(x - v[i]), 0);
const sumDelta = l1;
const median3 = (a, b, c) => [a, b, c].sort((x, y) => x - y)[1];

// Merge the caller's thresholds over the defaults (a missing or undefined key keeps the default) and
// refuse anything that is not an integer >= 0 — a NaN threshold would silently disable the rule.
function normaliseAgree(agree) {
  const a = {
    maxDomainDelta: agree?.maxDomainDelta ?? DEFAULT_AGREE.maxDomainDelta,
    maxSumDelta: agree?.maxSumDelta ?? DEFAULT_AGREE.maxSumDelta,
  };
  for (const k of ['maxDomainDelta', 'maxSumDelta']) {
    if (!Number.isInteger(a[k]) || a[k] < 0) {
      throw new Error(`scoreWithConsistency: agree.${k} must be an integer >= 0 (got ${JSON.stringify(a[k])})`);
    }
  }
  return a;
}

function isScoreError(e) {
  return e instanceof Pis7ScoreError || e?.name === 'Pis7ScoreError';
}

/**
 * @param {object}   opts
 * @param {(callIndex:number) => Promise<{text:string, inputTokens?:number, outputTokens?:number}>} opts.callOnce
 *                   one model call; `callIndex` counts every call made, re-asks included
 * @param {'off'|'adaptive'|'median3'} [opts.mode='off']
 * @param {number}   [opts.jsonRetries=2]  re-asks allowed across the whole run for unparseable replies
 * @param {{maxDomainDelta?:number, maxSumDelta?:number}} [opts.agree=DEFAULT_AGREE]  pair-agreement
 *                   thresholds (adaptive only); a missing key keeps the default
 * @returns {Promise<{scores, composite, rationale, billed:{inputTokens,outputTokens}, consistency}>}
 *   consistency = { method, mode, rule, calls, max_delta, sum_delta, agree: { max_domain_delta,
 *                   max_sum_delta }, per_call_scores, json_retries, extra_input_tokens,
 *                   extra_output_tokens, latency_ms }
 *   `calls` counts the VALID scored calls (1, 2 or 3 — the length of per_call_scores); the re-asks
 *   are `json_retries`; total model calls = calls + json_retries. `max_delta` / `sum_delta` are the
 *   decision statistics — the largest per-domain |Δ| and Σ|Δ| between c1 and c2 — and null for a
 *   single call. `agree` records the thresholds this run was configured with, in every mode.
 * @throws Pis7ScoreError once the re-ask budget is spent; anything else callOnce rejects with, as is.
 */
async function scoreWithConsistency({ callOnce, mode = 'off', jsonRetries = 2, agree = DEFAULT_AGREE }) {
  if (typeof callOnce !== 'function') throw new TypeError('scoreWithConsistency: callOnce must be a function');
  if (!MODES.includes(mode)) throw new Error(`Unknown consistency mode "${mode}". Valid: ${MODES.join(', ')}`);
  const thresholds = normaliseAgree(agree);
  const budget = Number.isFinite(jsonRetries) && jsonRetries >= 0 ? Math.floor(jsonRetries) : 0;

  const startedAt = Date.now();
  let callIndex = 0;
  let billed = null;                       // call 1's tokens, whatever it returned
  let extraInput = 0;
  let extraOutput = 0;
  let retriesUsed = 0;

  function account(reply) {
    const usage = { inputTokens: Number(reply.inputTokens) || 0, outputTokens: Number(reply.outputTokens) || 0 };
    if (billed === null) billed = usage;
    else { extraInput += usage.inputTokens; extraOutput += usage.outputTokens; }
  }

  // One VALID scored call, re-asking within the shared budget.
  async function scoredCall() {
    for (;;) {
      const reply = await callOnce(callIndex++);
      account(reply);
      try {
        const { scores, rationale } = scoreFromText(reply.text);
        return { vector: vectorOf(scores), rationale };
      } catch (e) {
        if (!isScoreError(e) || retriesUsed >= budget) throw e;
        retriesUsed++;
      }
    }
  }

  const finish = (rule, vector, rationale, perCall, max, sum) => {
    const scores = Object.fromEntries(DOMAIN_KEYS.map((k, i) => [k, vector[i]]));
    return {
      scores,
      composite: compositeOf(scores),
      rationale,
      billed,
      consistency: {
        method: METHOD,
        mode,
        rule,
        calls: perCall.length,
        max_delta: max,
        sum_delta: sum,
        agree: { max_domain_delta: thresholds.maxDomainDelta, max_sum_delta: thresholds.maxSumDelta },
        per_call_scores: perCall.map((c) => [...c.vector]),
        json_retries: retriesUsed,
        extra_input_tokens: extraInput,
        extra_output_tokens: extraOutput,
        latency_ms: Date.now() - startedAt,
      },
    };
  };

  const c1 = await scoredCall();
  if (mode === 'off') return finish(RULES.single, c1.vector, c1.rationale, [c1], null, null);

  const c2 = await scoredCall();
  const max = maxDelta(c1.vector, c2.vector);
  const sum = sumDelta(c1.vector, c2.vector);
  const pairAgrees = max <= thresholds.maxDomainDelta && (thresholds.maxSumDelta === 0 || sum <= thresholds.maxSumDelta);
  if (mode === 'adaptive' && pairAgrees) return finish(RULES.pair, c1.vector, c1.rationale, [c1, c2], max, sum);

  // adaptive with a disagreeing pair, or median3 unconditionally.
  const c3 = await scoredCall();
  const all = [c1, c2, c3];
  const median = DOMAIN_KEYS.map((_k, i) => median3(c1.vector[i], c2.vector[i], c3.vector[i]));
  // Closest call to the median carries the rationale; Array.prototype.reduce keeps the FIRST minimum,
  // which is the "ties → earliest call" rule.
  const closest = all.reduce((best, c) => (l1(c.vector, median) < l1(best.vector, median) ? c : best), all[0]);
  return finish(RULES.median, median, closest.rationale, all, max, sum);
}

module.exports = { scoreWithConsistency, METHOD, MODES, RULES, AGREE_WITHIN, DEFAULT_AGREE };
