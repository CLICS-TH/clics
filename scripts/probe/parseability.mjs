// How many of the local model's replies were valid PIS-7 JSON — the D18 parseability bar.
//
// This lives in its own module for one reason: it was inline in screening-verdict.mjs, and inline code
// cannot be tested. The same accounting bug was therefore fixed once in repeat-consistency.mjs and then
// reintroduced independently in TWO consumers, where it produced three different wrong answers about the
// same runs in a single day (95.4%, then "100%", against a true 94.4%) and a published conclusion that
// had to be retracted. The rules below are small; what they need is a test, and a test needs an export.
//
// TWO RULES, both learned the hard way:
//
// 1. ONLY a transport failure leaves the denominator.
//    A socket error or a timeout is the BOX failing and says nothing about the model's contract. But
//    `Pis7ScoreError` is NOT a transport failure — rimpl/src/lib/pis7.js throws it for `invalid_json`
//    and `invalid_scores`, and services/consistency.js re-raises it only after the re-ask budget is
//    spent, i.e. after the model produced unusable output N+1 times. That is exactly what this bar
//    exists to catch, and excluding it switches the bar off: a run with 5 of 18 rows failing went from
//    "66.7%, under 98%" to "100%, ok", and with every row failing the percentage goes null, at which
//    point it cannot pull a passing verdict down to a failing one at all.
//
//    The ambiguity that motivated that mistake is real and is NOT solvable here: `chatCompletion` never
//    throws, so a timeout returns { ok:false, text:'' }, the empty string parses to {}, the schema
//    fails, and a dead box and a garbage reply arrive as the same `Pis7ScoreError`. It is solved at the
//    CALL SITE, where `ok` is still visible — both probe scripts now stamp `transport …` there. Reports
//    written before that stamp cannot be re-scored, so they are counted the strict way and flagged:
//    over-reporting a model's failures is recoverable, under-reporting ships.
//
// 2. Count CALLS, not fixtures.
//    One adaptive row is 2–3 model calls plus re-asks, and `consistency.json_retries` already counts
//    replies that failed the schema. Counting a row as one attempt reported 17/17 = "100%" for a run
//    that made 36 calls, 2 of which did not parse.

/** A failure that belongs to the box, not the model. Deliberately narrow: only the marker the probe
 *  scripts stamp at the call site, never a guess from an error class name. */
export const isTransport = (e) => e != null && /^transport\b/i.test(String(e));

/**
 * @param {object[]} rows        agreement rows (model-agreement.mjs)
 * @param {object|null} repeat   a repeat-consistency report, or null
 * @returns {{attempted:number, parsed:number, excluded:number, legacy:boolean, pct:number|null, pass:boolean|null}}
 *   `legacy` means at least one input predates per-call accounting or the error stamp, so the figure is
 *   a floor rather than a rate and must be reported as such.
 */
export function computeParseability(rows = [], repeat = null) {
  let attempted = 0, parsed = 0, excluded = 0, legacy = false;

  for (const r of rows) {
    const calls = r.localCalls;
    if (typeof calls !== 'number') {
      // Pre-2026-09-04 report: one row counted as one attempt, and a timeout is indistinguishable from
      // bad JSON. Count it against the model — see rule 1.
      legacy = true;
      if (r.local) { attempted += 1; parsed += 1; }
      else if (r.cloudError && !r.localError) { excluded += 1; }
      else { attempted += 1; }
      continue;
    }
    if (isTransport(r.localError)) { excluded += calls || 1; continue; }
    if (!r.local && r.cloudError && !r.localError) { excluded += calls || 1; continue; }
    attempted += calls + (r.localJsonRetries ?? 0);
    // A failed row's last call is the one that could not be made valid; the earlier calls parsed.
    parsed += r.local ? calls : Math.max(0, calls - 1);
  }

  for (const r of (repeat?.results ?? []).filter((x) => x.arm === 'local')) {
    if (!Array.isArray(r.errors)) {
      legacy = true;
      attempted += (r.ms ?? []).length;
      parsed += (r.runs ?? []).length;
      continue;
    }
    const skipped = r.errors.filter(isTransport).length;
    excluded += skipped;
    attempted += (r.ms ?? []).length - skipped;
    parsed += (r.runs ?? []).length;
  }

  const pct = attempted ? (100 * parsed) / attempted : null;
  return { attempted, parsed, excluded, legacy, pct, pass: pct == null ? null : pct >= 98 };
}
