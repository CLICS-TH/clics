const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

function computeTier1(ple) {
  return {
    c1: (ple.duration_seconds ?? 0) >= 900,
    c2: (ple.turn_count ?? 0) >= 4,
    c3: (ple.token_count ?? 0) >= 800,
  };
}

// ×20 gives 0-100: max = 5 × 1.0 × 20 = 100
function compositeScore(scores) {
  return Object.entries(WEIGHTS).reduce(
    (acc, [key, w]) => acc + (scores[key] ?? 0) * w, 0
  ) * 20;
}

module.exports = { computeTier1, compositeScore, WEIGHTS };
