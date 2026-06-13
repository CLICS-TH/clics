// Semantic status colours for charts (#13) — single source of truth, was hardcoded inline across
// overview/icc. recharts sets SVG `fill`/`stroke` ATTRIBUTES, where CSS var() does not resolve, so
// charts import these hex constants. MIRROR of the --chart-pass/--chart-fail/--chart-threshold/--chart-warn
// tokens in app/globals.css (CSS-class usages reference those vars directly). Keep the two in sync.
export const CHART = {
  pass: "#5db872",
  fail: "#c64545",
  threshold: "#e8a55a",
  warn: "#e08a1e", // saturated amber for budget/usage-meter fills (also lib/labels.ts budgetToneHex)
} as const;
