const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

function computeTier1(cle) {
  return {
    c1: (cle.duration_seconds ?? 0) >= 600,
    c2: (cle.turn_count ?? 0) >= 4,
    c3: (cle.token_count ?? 0) >= 10000,
  };
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

module.exports = { computeTier1, compositeScore, clampDuration, WEIGHTS };
