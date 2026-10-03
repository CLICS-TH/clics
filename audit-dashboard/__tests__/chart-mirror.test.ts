// lib/chart-colors.ts is documented as a MIRROR of the --chart-* tokens in app/globals.css, because
// recharts writes SVG fill/stroke ATTRIBUTES, where CSS var() does not resolve. Until now nothing
// enforced the mirror, so a token change shipped half-applied: the CSS-class consumers moved and the
// charts did not. This parses the stylesheet and fails on any drift, in either theme.
import fs from 'fs';
import path from 'path';
import { CHART_DARK, CHART_LIGHT, chartColors, useChartColors, type ChartPalette } from '@/lib/chart-colors';
import { ThemeProvider } from '@/components/ThemeProvider';
import { act, renderHook } from '@testing-library/react';
import React from 'react';

const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'globals.css'), 'utf8');

function block(selector: string): string {
  const m = new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'm').exec(css);
  if (!m) throw new Error(`${selector} not found in globals.css`);
  return css.slice(m.index, css.indexOf('\n}', m.index));
}
function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block(selector).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

// palette key -> CSS custom property
const MAP: Record<keyof ChartPalette, string> = {
  pass: 'chart-pass',
  fail: 'chart-fail',
  threshold: 'chart-threshold',
  warn: 'chart-warn',
  teal: 'chart-teal',
  human: 'chart-human',
  ai: 'chart-ai',
  peer: 'chart-peer',
};

function drift(palette: ChartPalette, effective: Record<string, string>) {
  return (Object.keys(MAP) as (keyof ChartPalette)[])
    .filter((k) => palette[k].toLowerCase() !== effective[MAP[k]])
    .map((k) => `${k}: chart-colors.ts ${palette[k]} vs --${MAP[k]} ${effective[MAP[k]]}`);
}

describe('chart-colors.ts mirrors the --chart-* tokens in globals.css', () => {
  const light = tokens(':root');
  // .dark sits on the same element as :root, so a token it does not redeclare is inherited.
  const dark = { ...light, ...tokens('.dark') };

  it('reads real token blocks (a silent parse failure would make the mirror checks vacuous)', () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(Object.keys(tokens('.dark')).length).toBeGreaterThan(10);
  });

  it('light palette matches :root', () => { expect(drift(CHART_LIGHT, light)).toEqual([]); });
  it('dark palette matches .dark (falling back to :root where .dark is silent)', () => {
    expect(drift(CHART_DARK, dark)).toEqual([]);
  });

  it('the light set differs from the dark one exactly where the dark hues fail 3:1 on the light card', () => {
    // pass / threshold / warn / teal were darkened for light; the series colours and fail were not.
    const changed = (Object.keys(MAP) as (keyof ChartPalette)[]).filter((k) => CHART_LIGHT[k] !== CHART_DARK[k]);
    expect(changed.sort()).toEqual(['pass', 'teal', 'threshold', 'warn']);
  });
});

describe('chartColors / useChartColors', () => {
  afterEach(async () => { await act(async () => { document.documentElement.classList.remove('dark'); }); localStorage.clear(); });

  it('chartColors picks the set for the theme', () => {
    expect(chartColors('light')).toBe(CHART_LIGHT);
    expect(chartColors('dark')).toBe(CHART_DARK);
  });

  it('useChartColors follows the resolved theme, including a flip while mounted', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(ThemeProvider, null, children);
    const { result } = renderHook(() => useChartColors(), { wrapper });
    expect(result.current).toBe(CHART_LIGHT);
    // The provider watches the <html> class with a MutationObserver, which fires on a microtask.
    await act(async () => { document.documentElement.classList.add('dark'); });
    expect(result.current).toBe(CHART_DARK);
  });

  it('without a provider it falls back to the light set', () => {
    const { result } = renderHook(() => useChartColors());
    expect(result.current).toBe(CHART_LIGHT);
  });
});
