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
  // The manual (/manual). Its quoted UI-label chips sit on a TINT by design, where --link fails
  // (4.20:1 on --muted, 3.94:1 on --secondary) — which is why --coral-on-tint exists.
  ['coral-on-tint', 'muted', 'manual: quoted UI-label chip'],
  ['coral-on-tint', 'secondary', 'manual: quoted UI-label chip inside a callout'],
  ['coral-on-tint', 'background', 'manual: step counter badge'],
  ['muted-foreground', 'muted', 'manual: figure captions and the section-index numbers'],
  ['foreground', 'muted', 'auditor reveal: ConsistencyChip (repeat-scoring metadata) on its bg-muted pill'],
];

const PORTAL_PAIRS: [string, string, string][] = [
  ['muted', 'canvas', '.sub / .note in a page-intro'],
  ['muted', 'surface-card', '.sub / .note inside a card — ple-reflect, acceptability'],
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

/*
 * TINT pairs: a foreground token over `--tint` composited at ALPHA onto `--surface`.
 *
 * The palette reader above deliberately skips rgba/alpha values, with the right reasoning — a pair
 * that cannot be computed honestly must not be asserted as if it could. But Tailwind's `/NN` opacity
 * utilities make those pairs REAL and rendered, and until now the guard could not see any of them.
 * `bg-primary/12 text-coral-on-tint` is painted on /manual and on the integrity queue's medium
 * severity badge, and no entry above covers it: `--coral-on-tint` is pinned against `--muted`,
 * `--secondary` and `--background`, none of which is this surface.
 *
 * So compositing is done here explicitly rather than skipped: src-over at ALPHA, which is exactly
 * what the browser paints for a solid tint on an opaque surface.
 */
type TintPair = [fg: string, tint: string, alpha: number, surface: string, where: string];

function over(tint: string, alpha: number, surface: string): string {
  const [t, s] = [hexToRgb(tint), hexToRgb(surface)];
  return '#' + t.map((c, i) => Math.round(c * alpha + s[i] * (1 - alpha))
    .toString(16).padStart(2, '0')).join('');
}

const DASH_TINTS: TintPair[] = [
  ['coral-on-tint', 'primary', 0.12, 'card',
    'manual: language toggle (active); integrity queue: MEDIUM severity badge'],
  ['danger', 'destructive', 0.10, 'card', 'integrity queue: HIGH severity badge'],
];

function checkTints(name: string, css: string, sel: string, pairs: TintPair[]) {
  const p = palette(css, sel);
  const failures: string[] = [];
  for (const [fg, tint, alpha, surface, where] of pairs) {
    if (!p[fg] || !p[tint] || !p[surface]) {
      failures.push(`${name}: --${fg}/--${tint}/--${surface} is not a hex token in ${sel} (${where})`);
      continue;
    }
    const bg = over(p[tint], alpha, p[surface]);
    const r = ratio(p[fg], bg);
    if (r < AA) {
      failures.push(`${name}: --${fg} ${p[fg]} on --${tint}/${Math.round(alpha * 100)} over --${surface} `
        + `(= ${bg}) = ${r.toFixed(2)}:1 (needs ${AA}) — ${where}`);
    }
  }
  return failures;
}

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

  it('the compositor agrees with the endpoints', () => {
    // alpha 1 is the tint itself, alpha 0 is the surface. Without this a broken `over` would
    // silently measure the wrong colour and report a pass.
    expect(over('#cc785c', 1, '#faf9f5')).toBe('#cc785c');
    expect(over('#cc785c', 0, '#faf9f5')).toBe('#faf9f5');
    expect(over('#cc785c', 0.12, '#faf9f5')).toBe('#f4eae3');   // measured against the render
  });

  it('audit-dashboard — light', () => {
    expect(check('dash light', dash, ':root', DASH_PAIRS)).toEqual([]);
  });

  it('audit-dashboard tints — light', () => {
    expect(checkTints('dash light', dash, ':root', DASH_TINTS)).toEqual([]);
  });

  it('audit-dashboard tints — dark', () => {
    expect(checkTints('dash dark', dash, '.dark', DASH_TINTS)).toEqual([]);
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

// ===== BEGIN audit-dashboard design-a11y ===========================================================
// Appended as its own block (physician-ui's parallel branch appends a `physician-ui design-a11y` block
// to this same file) — both blocks are purely additive, so a merge is "take both".
//
// Everything above asserts ONE bar (4.5:1 text). This block adds a per-pair MINIMUM, because the new
// tokens are mostly non-text UI (a form-field edge, a focus ring, a chart mark) where WCAG 1.4.11 asks
// for 3:1, and holding them to 4.5 would be as wrong as holding text to 3.
type MinPair = [fg: string, bg: string, min: number, where: string];

const NON_TEXT = 3;

const DA_PAIRS: MinPair[] = [
  // --- amber text. Was 4.51 on the canvas (0.01 of margin) and not guarded at all.
  ['warn', 'background', AA, 'payout amber on the page (admin/compensation)'],
  ['warn', 'card', AA, 'payout amber inside a Card'],
  // --- tinted status pairs (shared hex with physician-ui)
  ['notice-text', 'notice-bg', AA, 'StateMessage notice / Badge notice'],
  ['error-text', 'error-bg', AA, 'StateMessage error / Badge error'],
  // --- the AI treatment: text on its fill, and its border as the non-text edge
  ['ai-text', 'ai-bg', AA, 'AiOutput body, AI Score card, assistant bubbles'],
  ['ai-border', 'ai-bg', NON_TEXT, 'AiOutput border against its own fill'],
  ['ai-border', 'background', NON_TEXT, 'AiOutput border against the page'],
  ['ai-border', 'card', NON_TEXT, 'AiOutput border inside a Card'],
  // Everything ELSE that is painted on the AI surface: Markdown links and the Socratic line use
  // --coral-on-tint (--link is 4.24:1 here and would fail), citations use muted, bold uses foreground.
  ['coral-on-tint', 'ai-bg', AA, 'AiOutput: Markdown links, Socratic question line'],
  ['muted-foreground', 'ai-bg', AA, 'AiOutput: citation line, blockquotes'],
  ['foreground', 'ai-bg', AA, 'AiOutput: Markdown strong / code'],
  // Badge ok tone (+ the ICC chips and StatStrip pass figure that share the same pair)
  ['chart-pass-text', 'chart-pass-bg', AA, 'Badge ok, ICC >= 0.95 chip, council ICC chip'],
  // --- form controls: the edge of a text field is a UI component (1.4.11)
  ['field', 'background', NON_TEXT, 'ui/input on the page'],
  ['field', 'card', NON_TEXT, 'ui/input inside a Card'],
  ['field', 'secondary', NON_TEXT, 'ui/input on a tinted (bg-secondary) panel'],
  ['field', 'muted', NON_TEXT, 'ui/input on a bg-muted panel'],
  // --- the focus ring (2.4.7 / 1.4.11)
  ['ring', 'background', NON_TEXT, ':focus-visible on the page'],
  ['ring', 'card', NON_TEXT, ':focus-visible inside a Card'],
  ['ring', 'secondary', NON_TEXT, ':focus-visible on a tinted panel'],
  ['ring', 'muted', NON_TEXT, ':focus-visible on a bg-muted panel'],
  // --- chart marks vs the card they are drawn on (1.4.11). `fail` is a mark AND a 4xl stat figure.
  ['chart-pass', 'card', NON_TEXT, 'ICC bars, usage meter pass fill'],
  ['chart-fail', 'card', NON_TEXT, 'ICC fail bars, limits of agreement'],
  ['chart-threshold', 'card', NON_TEXT, '0.75 threshold reference line'],
  ['chart-warn', 'card', NON_TEXT, 'usage meter warn fill'],
  ['chart-teal', 'card', NON_TEXT, 'Bland-Altman mean line'],
  ['chart-human', 'card', NON_TEXT, 'radar: auditor series'],
  ['chart-ai', 'card', NON_TEXT, 'radar: AI series'],
  ['chart-peer', 'card', NON_TEXT, 'radar: peer-average series'],
];

// Tokens declared only in :root are inherited by .dark (same element), so the dark palette is the
// light one overlaid with the .dark block — which is what the browser computes.
function effective(css: string, sel: string): Record<string, string> {
  return sel === ':root' ? palette(css, ':root') : { ...palette(css, ':root'), ...palette(css, sel) };
}

function checkMin(name: string, css: string, sel: string, pairs: MinPair[]) {
  const p = effective(css, sel);
  const failures: string[] = [];
  for (const [fg, bg, min, where] of pairs) {
    if (!p[fg] || !p[bg]) {
      failures.push(`${name}: --${fg} or --${bg} is not a hex token in ${sel} (${where})`);
      continue;
    }
    const r = ratio(p[fg], p[bg]);
    if (r < min) failures.push(`${name}: --${fg} ${p[fg]} on --${bg} ${p[bg]} = ${r.toFixed(2)}:1 (needs ${min}) — ${where}`);
  }
  return failures;
}

// Tinted fills at the alphas Badge/Button actually paint, INCLUDING the dark ones the 0.10-only
// DASH_TINTS above cannot see: dark Badge destructive is /20 and its hover is /30; light hover is /20.
// Before this block --danger measured 4.47:1 on the dark /20 tint and 4.01:1 on /30, and nothing said so.
const DA_TINTS: { sel: string; name: string; pairs: TintPair[] }[] = [
  { sel: ':root', name: 'light', pairs: [
    ['danger', 'destructive', 0.10, 'card', 'Badge/Button destructive, light'],
    ['danger', 'destructive', 0.20, 'card', 'Badge/Button destructive :hover, light'],
  ] },
  { sel: '.dark', name: 'dark', pairs: [
    ['danger', 'destructive', 0.20, 'card', 'Badge/Button destructive, dark'],
    ['danger', 'destructive', 0.30, 'card', 'Badge/Button destructive :hover, dark'],
    ['danger', 'destructive', 0.20, 'background', 'destructive tint straight on the page, dark'],
  ] },
];

describe('audit-dashboard design-a11y — per-pair minimums and the new tokens', () => {
  const dash = fs.readFileSync(DASH_CSS, 'utf8');

  it('the effective-palette overlay lets .dark inherit tokens it does not redeclare', () => {
    // --chart-human lives only in :root; if the overlay broke, every dark chart pair would report
    // "not a hex token" instead of being measured.
    expect(effective(dash, '.dark')['chart-human']).toBe(palette(dash, ':root')['chart-human']);
    expect(effective(dash, '.dark').field).toBe(palette(dash, '.dark').field);
  });

  it('light', () => { expect(checkMin('dash light', dash, ':root', DA_PAIRS)).toEqual([]); });
  it('dark', () => { expect(checkMin('dash dark', dash, '.dark', DA_PAIRS)).toEqual([]); });

  it.each(DA_TINTS)('alpha tints — $name', ({ sel, name, pairs }) => {
    expect(checkTints(`dash ${name}`, dash, sel, pairs)).toEqual([]);
  });

  it('every new design-a11y token is a hex in BOTH themes (no theme-blind utility)', () => {
    const tokens = ['field', 'notice-bg', 'notice-text', 'error-bg', 'error-text', 'ai-bg', 'ai-border',
      'ai-text', 'ring', 'warn', 'chart-teal', 'chart-pass', 'chart-threshold', 'chart-warn'];
    const missing: string[] = [];
    for (const sel of [':root', '.dark']) {
      const p = palette(dash, sel);
      for (const t of tokens) if (!p[t]) missing.push(`--${t} missing (as a hex) from ${sel}`);
    }
    expect(missing).toEqual([]);
  });

  it('the AI palette matches the values the physician-ui branch ships (the two apps must agree)', () => {
    expect(palette(dash, ':root')).toMatchObject({ 'ai-bg': '#eef2f9', 'ai-border': '#4f72ad', 'ai-text': '#2c4673' });
    expect(palette(dash, '.dark')).toMatchObject({ 'ai-bg': '#1b2536', 'ai-border': '#7f9fd4', 'ai-text': '#c9d9f4' });
  });
});
// ===== END audit-dashboard design-a11y =============================================================
