// Adaptive self-consistency for the PIS-7 evaluator. PURE and injectable: no provider, no env, no
// route — one `callOnce(callIndex)` the caller supplies, and the rule below — so a probe script can
// run the identical rule offline against saved replies.
//
// WHY. On the same fixture, same prompt, temperature 0, the evaluator's Σ|Δ| across sessions was 0–8
// on BOTH models. The D18 screening gate (lower CI >= 0.75 against the incumbent) cannot pass with
// that noise, so the local arm scores two or three times and reconciles:
//
//   c1, c2 → every domain agrees within 1     → final = c1        rule 'first-of-agreeing-pair'
//          → otherwise c3                     → final = per-domain median of the three
//                                                                 rule 'median-of-3'
//            rationale from the call whose score vector is closest (L1) to the median; ties → the
//            earliest call. mode 'off' → one call, rule 'single'.
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

const METHOD = 'self-consistency';
const MODES = ['off', 'adaptive'];
const RULES = { single: 'single', pair: 'first-of-agreeing-pair', median: 'median-of-3' };
// Two calls "agree" when no domain differs by more than this.
const AGREE_WITHIN = 1;

const vectorOf = (scores) => DOMAIN_KEYS.map((k) => scores[k]);
const maxDelta = (u, v) => Math.max(...u.map((x, i) => Math.abs(x - v[i])));
const l1 = (u, v) => u.reduce((acc, x, i) => acc + Math.abs(x - v[i]), 0);
const median3 = (a, b, c) => [a, b, c].sort((x, y) => x - y)[1];

function isScoreError(e) {
  return e instanceof Pis7ScoreError || e?.name === 'Pis7ScoreError';
}

/**
 * @param {object}   opts
 * @param {(callIndex:number) => Promise<{text:string, inputTokens?:number, outputTokens?:number}>} opts.callOnce
 *                   one model call; `callIndex` counts every call made, re-asks included
 * @param {'off'|'adaptive'} [opts.mode='off']
 * @param {number}   [opts.jsonRetries=2]  re-asks allowed across the whole run for unparseable replies
 * @returns {Promise<{scores, composite, rationale, billed:{inputTokens,outputTokens}, consistency}>}
 *   consistency = { method, mode, rule, calls, max_delta, per_call_scores, json_retries,
 *                   extra_input_tokens, extra_output_tokens, latency_ms }
 *   `calls` counts the VALID scored calls (1, 2 or 3 — the length of per_call_scores); the re-asks
 *   are `json_retries`; total model calls = calls + json_retries. `max_delta` is the decision
 *   statistic — the largest per-domain |Δ| between c1 and c2 — and null for a single call.
 * @throws Pis7ScoreError once the re-ask budget is spent; anything else callOnce rejects with, as is.
 */
async function scoreWithConsistency({ callOnce, mode = 'off', jsonRetries = 2 }) {
  if (typeof callOnce !== 'function') throw new TypeError('scoreWithConsistency: callOnce must be a function');
  if (!MODES.includes(mode)) throw new Error(`Unknown consistency mode "${mode}". Valid: ${MODES.join(', ')}`);
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

  const finish = (rule, vector, rationale, perCall, delta) => {
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
        max_delta: delta,
        per_call_scores: perCall.map((c) => [...c.vector]),
        json_retries: retriesUsed,
        extra_input_tokens: extraInput,
        extra_output_tokens: extraOutput,
        latency_ms: Date.now() - startedAt,
      },
    };
  };

  const c1 = await scoredCall();
  if (mode === 'off') return finish(RULES.single, c1.vector, c1.rationale, [c1], null);

  const c2 = await scoredCall();
  const delta = maxDelta(c1.vector, c2.vector);
  if (delta <= AGREE_WITHIN) return finish(RULES.pair, c1.vector, c1.rationale, [c1, c2], delta);

  const c3 = await scoredCall();
  const all = [c1, c2, c3];
  const median = DOMAIN_KEYS.map((_k, i) => median3(c1.vector[i], c2.vector[i], c3.vector[i]));
  // Closest call to the median carries the rationale; Array.prototype.reduce keeps the FIRST minimum,
  // which is the "ties → earliest call" rule.
  const closest = all.reduce((best, c) => (l1(c.vector, median) < l1(best.vector, median) ? c : best), all[0]);
  return finish(RULES.median, median, closest.rationale, all, delta);
}

module.exports = { scoreWithConsistency, METHOD, MODES, RULES, AGREE_WITHIN };
