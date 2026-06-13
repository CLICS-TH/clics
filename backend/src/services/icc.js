function computeICC21(pairs) {
  const n = pairs.length;
  if (n < 2) return null;

  const k = 2;
  const grandMean = pairs.reduce((a, p) => a + p.ai + p.human, 0) / (n * k);
  const rowMeans = pairs.map(p => (p.ai + p.human) / 2);
  const colMeans = [
    pairs.reduce((a, p) => a + p.ai, 0) / n,
    pairs.reduce((a, p) => a + p.human, 0) / n,
  ];

  const SSr = k * rowMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SStotal = pairs.reduce((a, p) => a + (p.ai - grandMean) ** 2 + (p.human - grandMean) ** 2, 0);
  const SSe = SStotal - SSr - SSc;

  // Degenerate: every score is identical (AI == human, same value on every pair) — common per-domain
  // when a 0-5 domain is scored the same across sessions. There is no variance to partition, so ICC
  // is undefined. Return a clear 'insufficient variance' result instead of the spurious -0.999
  // 'Below target' the MSe floor produced (perfect agreement was being reported as the worst case).
  if (SStotal < 1e-9) {
    return { icc: null, lower: null, upper: null, n, interpretation: 'Insufficient variance (identical scores)' };
  }

  const MSr = SSr / (n - 1);
  const MSc = SSc / (k - 1);
  const MSe = Math.max(SSe / ((n - 1) * (k - 1)), 0.0001);

  const icc = (MSr - MSe) / (MSr + (k - 1) * MSe + k * (MSc - MSe) / n);

  const safeIcc = Math.min(Math.max(icc, -0.999), 0.999);
  const z = 0.5 * Math.log((1 + safeIcc) / (1 - safeIcc));
  const se = 1 / Math.sqrt(Math.max(n - 3, 1));
  const lower = Math.tanh(z - 1.96 * se);
  const upper = Math.tanh(z + 1.96 * se);

  // Label off the clamped value so it matches the displayed icc (a wildly negative raw value still
  // reads as 'Below target', never flips the bands).
  const label = safeIcc >= 0.95 ? 'Excellent'
    : safeIcc >= 0.85 ? 'Very Good'
    : safeIcc >= 0.75 ? 'Good'
    : 'Below target (< 0.75)';

  return {
    icc: Math.round(safeIcc * 1000) / 1000,
    lower: Math.round(Math.max(lower, 0) * 1000) / 1000,
    upper: Math.round(Math.min(upper, 1) * 1000) / 1000,
    n,
    interpretation: label,
  };
}

module.exports = { computeICC21 };
