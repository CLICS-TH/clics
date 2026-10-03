// Semantic status colours for charts (#13) — single source of truth, was hardcoded inline across
// overview/icc. recharts sets SVG `fill`/`stroke` ATTRIBUTES, where CSS var() does not resolve, so
// charts import these hex constants.
//
// THEME-AWARE. The dark-mode hues (#5db872 / #e8a55a / #e08a1e / #5db8a6) measure 2.33 / 2.00 / 2.55 /
// 2.25:1 on the light card — under the 3:1 non-text bar — so the light set carries darker variants.
// CHART_LIGHT and CHART_DARK are MIRRORS of the --chart-* tokens in :root and .dark of
// app/globals.css; __tests__/chart-mirror.test.ts parses the stylesheet and fails if either drifts.
// Consumers call useChartColors() (inside a component) or chartColors(theme) (anywhere else).
import { useTheme } from '@/components/ThemeProvider';

export type ChartPalette = {
  pass: string;
  fail: string;
  threshold: string;
  warn: string;      // saturated amber for budget/usage-meter fills (also lib/labels.ts budgetToneHex)
  teal: string;      // Bland-Altman mean-difference line
  // Two-series comparison (PIS-7 auditor-vs-AI radar): coral = the human auditor ("you", matches
  // --primary), slate-blue = the AI — distinct from the pass/fail/warn semantics above.
  human: string;
  ai: string;
  // Peer-calibration radar (you vs the auditor-cohort average): violet — distinct from coral/blue
  // above and from the pass-green/warn-amber semantics.
  peer: string;
};

export const CHART_LIGHT: ChartPalette = {
  pass: '#2f8a4b',
  fail: '#c64545',
  threshold: '#b8741a',
  warn: '#b86e00',
  teal: '#2f8f7e',
  human: '#cc785c',
  ai: '#5b7fb9',
  peer: '#8d6fc9',
};

export const CHART_DARK: ChartPalette = {
  pass: '#5db872',
  fail: '#c64545',
  threshold: '#e8a55a',
  warn: '#e08a1e',
  teal: '#5db8a6',
  human: '#cc785c',
  ai: '#5b7fb9',
  peer: '#8d6fc9',
};

export function chartColors(theme: 'light' | 'dark'): ChartPalette {
  return theme === 'dark' ? CHART_DARK : CHART_LIGHT;
}

/** The chart palette for the theme currently on screen (re-renders when the theme flips). */
export function useChartColors(): ChartPalette {
  return chartColors(useTheme().theme);
}
