// Measured WCAG contrast on the token pairs both apps actually render, in both themes.
//
// WHY THIS EXISTS. Contrast has been fixed here three times and regressed twice, because a token is
// edited in one place and read in twenty, and nothing in tsc, lint or the component tests can see a
// colour. The 2026-08 audit found `--muted` at 4.48:1 on `--surface-card` — a two-hundredths miss,
// invisible to review, live on the reflection and acceptability forms.
//
// So the pairs are pinned here and computed from the stylesheets themselves. Nudge a token and this
// says so, with the number.
//
// SCOPE: only pairs that are actually rendered. A pair nobody paints is not a bug, and padding the
// list with hypotheticals is how a guard becomes noise people learn to edit around.
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..');
const DASH_CSS = path.join(REPO, 'audit-dashboard', 'app', 'globals.css');
const PORTAL_CSS = path.join(REPO, 'physician-ui', 'public', 'css', 'main.css');

// --- WCAG 2.1 relative luminance + contrast ratio ------------------------------------------------
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: number[]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function hexToRgb(hex: string): number[] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function ratio(fg: string, bg: string): number {
  const [a, b] = [luminance(hexToRgb(fg)), luminance(hexToRgb(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// --- palette extraction --------------------------------------------------------------------------
// Reads one selector block's `--token: #hex;` declarations. Deliberately ignores non-hex values
// (rgba tints, var() aliases): those need compositing against a known surface, and a pair that
// cannot be computed honestly must not be asserted as if it could.
function palette(css: string, selector: string): Record<string, string> {
  // Anchored to the start of a line and to the opening brace. A bare indexOf finds `.dark` inside a
  // comment or a `dark:` utility first, and then silently reads the wrong block — which reports every
  // token as missing rather than as failing, and looks like a broken test instead of a broken colour.
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
  const m = re.exec(css);
  if (!m) throw new Error(`selector ${selector} not found — did the stylesheet change shape?`);
  const start = m.index;
  const block = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

const AA = 4.5;

// Each entry: [foreground token, background token, where it is rendered]. The note is the evidence
// that the pair is real — without it nobody can tell a live pair from a guess.
const DASH_PAIRS: [string, string, string][] = [
  ['muted-foreground', 'background', 'secondary text on the page ground, everywhere'],
  ['muted-foreground', 'card', 'secondary text inside a Card / bg-card panel'],
  ['muted-foreground', 'secondary', 'privacy + identity filter chips on hover (bg-secondary)'],
  ['foreground', 'background', 'body text'],
  ['foreground', 'card', 'body text inside a card'],
  ['danger', 'background', 'error text, admin screens'],
  ['danger', 'card', 'ai-readiness "could not reach RIMPL" panel, evaluator-lock gate notes'],
  ['ok', 'background', 'success text'],
  ['ok', 'card', 'ai-readiness embedding + context readings'],
  ['primary-foreground', 'coral-active', 'Button default + Badge default (white on coral)'],
  ['link', 'background', 'link variant'],
];

const PORTAL_PAIRS: [string, string, string][] = [
  ['muted', 'canvas', '.sub / .note in a page-intro'],
  ['muted', 'surface-card', '.sub / .note inside a card — cle-reflect, acceptability'],
  ['muted', 'surface-soft', '.sub on the soft surface'],
  ['muted-soft', 'surface-card', 'the sibling token, same surfaces'],
  ['body-color', 'canvas', 'body text'],
  ['body-color', 'surface-card', 'body text in a card'],
  ['on-primary', 'coral-active', '.btn-primary at rest'],
  ['on-primary', 'coral-hover', '.btn-primary:hover'],
  ['on-primary', 'coral-press', '.btn-primary:active'],
  ['coral-text', 'canvas', '.artifact-kind, coral text on the canvas'],
  ['coral-on-card', 'surface-card', '.msg-socratic body (the coral-ring tint sits on the card)'],
  ['error-text', 'error-bg', 'error banners'],
  ['success-text', 'success-bg', 'success banners'],
  ['warning-text', 'warning-bg', 'warning banners'],
];

function check(name: string, css: string, sel: string, pairs: [string, string, string][]) {
  const p = palette(css, sel);
  const failures: string[] = [];
  for (const [fg, bg, where] of pairs) {
    if (!p[fg] || !p[bg]) {
      failures.push(`${name}: --${fg} or --${bg} is not a hex token in ${sel} (${where})`);
      continue;
    }
    const r = ratio(p[fg], p[bg]);
    if (r < AA) {
      failures.push(`${name}: --${fg} ${p[fg]} on --${bg} ${p[bg]} = ${r.toFixed(2)}:1 (needs ${AA}) — ${where}`);
    }
  }
  return failures;
}

describe('WCAG AA on the token pairs both apps render', () => {
  const dash = fs.readFileSync(DASH_CSS, 'utf8');
  const portal = fs.readFileSync(PORTAL_CSS, 'utf8');

  it('reads both stylesheets', () => {
    // A silent read failure would make every assertion below vacuous.
    expect(dash.length).toBeGreaterThan(1000);
    expect(portal.length).toBeGreaterThan(1000);
    expect(Object.keys(palette(dash, ':root')).length).toBeGreaterThan(10);
    expect(Object.keys(palette(portal, ':root')).length).toBeGreaterThan(10);
  });

  it('the ratio function agrees with the published examples', () => {
    // Black on white is exactly 21:1 and a colour on itself is exactly 1:1. Without this, a broken
    // luminance function would report everything as passing.
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(ratio('#6c6a64', '#efe9de')).toBeCloseTo(4.48, 2);   // the miss this file was written for
  });

  it('audit-dashboard — light', () => {
    expect(check('dash light', dash, ':root', DASH_PAIRS)).toEqual([]);
  });

  it('audit-dashboard — dark', () => {
    expect(check('dash dark', dash, '.dark', DASH_PAIRS)).toEqual([]);
  });

  it('physician-ui — light', () => {
    expect(check('portal light', portal, ':root', PORTAL_PAIRS)).toEqual([]);
  });

  it('physician-ui — dark', () => {
    expect(check('portal dark', portal, ':root[data-theme="dark"]', PORTAL_PAIRS)).toEqual([]);
  });
});
