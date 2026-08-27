const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

// C1-C3 are effort measures: engagement time, turns, and transcript size. They used to be a HARD
// GATE — a session missing any of them was terminated at 'cle_fail_t1' and never scored.
//
// CREC082 does not define a PLE that way. PLE Instruction Sheet §1 defines it by four qualities —
// a meaningful problem, developing reasoning, integration of context/evidence, and reflective
// synthesis — and by what it is not: a short factual lookup, repeated questioning, or passive
// copying. No minute count, no token count. Under the old gate a concise, genuinely reflective
// session was rejected unscored while a rambling 15-minute factual lookup sailed through, which is
// the wrong way round.
//
// So these are now METADATA: computed on every session, persisted to c1_pass..c3_pass, reported,
// and analysable — but not a verdict. The qualifying decision is c4..c7 in cle-finalize.js.
//
// C2 keeps one real job: >=4 physician turns is the threshold at which the Socratic rescue may open
// mid-session (§4). That is its correct protocol role — a trigger, not a bar.
function computeTier1(cle) {
  return {
    c1: (cle.duration_seconds ?? 0) >= 600,
    c2: (cle.turn_count ?? 0) >= 4,
    c3: (cle.token_count ?? 0) >= 10000,
  };
}

// The one floor that survives, and it is not a quality judgement: a conversation with no physician
// turn in it has nothing to classify. Sending it to the qualifying classifier would spend a paid
// call to be told what is already obvious from the row. Anything with content goes forward and is
// judged on the four elements, however brief.
function hasScorableContent(cle) {
  return (cle.turn_count ?? 0) >= 1;
}

// Active-engagement time is client-reported (idle/backgrounded time excluded) but can never exceed
// elapsed wall-clock. Clamp it so C1 (>=600s, the 10-min CME-credit engagement gate) cannot be gamed
// by an inflated active_seconds. Fall back to wall-clock when the client didn't report a usable value.
function clampDuration(reportedSeconds, wallClockSeconds) {
  const r = Number(reportedSeconds);
  return Number.isFinite(r) && r >= 0 ? Math.min(Math.round(r), wallClockSeconds) : wallClockSeconds;
}

// ×20 gives 0-100: max = 5 × 1.0 × 20 = 100. Round to 2dp: the raw weighted sum produces IEEE-754
// dust (e.g. {d7:3} -> 6.000000000000001) that would otherwise persist into ai_evaluations /
// audit_scores / lpdp_snapshots and the ICC pairs.
function compositeScore(scores) {
  const raw = Object.entries(WEIGHTS).reduce(
    (acc, [key, w]) => acc + (scores[key] ?? 0) * w, 0
  ) * 20;
  return Math.round(raw * 100) / 100;
}

module.exports = { computeTier1, hasScorableContent, compositeScore, clampDuration, WEIGHTS };
