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

// ===================================================================================================
// physician-ui design-a11y  (self-contained block: appended whole so it merges cleanly with any
// other edit to this file; it reuses palette()/ratio() above and changes nothing in them)
// ===================================================================================================
//
// The pairs above all assert ONE threshold (4.5, text). The 2026-10 design-a11y pass added tokens that
// are not text: a field border and a keyboard-focus ring are UI components under WCAG 1.4.11, which asks
// 3:1, not 4.5:1. Holding them to 4.5 would be wrong in the other direction (it would reject a border
// that is fine), so every pair here carries its OWN minimum.
//
//   --field-border  the edge of an input, textarea, select, the chat composer and option rows
//   --focus         the global :focus-visible outline colour
//   --error-text    .error-msg, moved off --error (4.27:1 on --surface-soft, 4.01:1 on --surface-card)
//
// --field-border has the same hex as the audit-dashboard's own field border so the two apps mirror.
const UI_MIN = 3;
type MinPair = [fg: string, bg: string, min: number, where: string];

// Surfaces a field or a focused control can sit on, in both themes.
const DA_SURFACES = ['canvas', 'surface-soft', 'surface-card'];
const DA_BOTH: MinPair[] = [
  ...DA_SURFACES.map((s): MinPair => ['field-border', s, UI_MIN,
    `input / textarea / select / composer / option-row border on ${s} (WCAG 1.4.11)`]),
  ...DA_SURFACES.map((s): MinPair => ['focus', s, UI_MIN,
    `global :focus-visible ring on ${s} (WCAG 1.4.11 / 2.4.7)`]),
  ...DA_SURFACES.map((s): MinPair => ['error-text', s, AA,
    `.error-msg text on ${s}`]),
];
// Dark theme also has an elevated surface (modals, hovered rows) a ring or border can land on.
const DA_DARK_ONLY: MinPair[] = [
  ['field-border', 'surface-dark-elevated', UI_MIN, 'field border on the elevated dark surface'],
  ['focus', 'surface-dark-elevated', UI_MIN, 'focus ring on the elevated dark surface'],
  ['error-text', 'surface-dark-elevated', AA, '.error-msg text on the elevated dark surface'],
];

function checkMin(name: string, css: string, sel: string, pairs: MinPair[]) {
  const p = palette(css, sel);
  const failures: string[] = [];
  for (const [fg, bg, min, where] of pairs) {
    if (!p[fg] || !p[bg]) {
      failures.push(`${name}: --${fg} or --${bg} is not a hex token in ${sel} (${where})`);
      continue;
    }
    const r = ratio(p[fg], p[bg]);
    if (r < min) {
      failures.push(`${name}: --${fg} ${p[fg]} on --${bg} ${p[bg]} = ${r.toFixed(2)}:1 (needs ${min}) — ${where}`);
    }
  }
  return failures;
}

// Body of the first rule whose selector line starts with `selectorTail` — so a token that is defined and
// pinned above but no longer APPLIED (someone reverts one rule to --hairline) is still caught.
function ruleBody(css: string, selectorTail: string): string {
  // Anchored to the start of a line: a bare match finds `html[data-mobile] .conv-move {` or
  // `.hero-stats[hidden] {` first and reads the wrong rule.
  const re = new RegExp(`^${selectorTail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  if (!m) throw new Error(`rule ${selectorTail} not found in main.css — did the stylesheet change shape?`);
  return m[1];
}

describe('physician-ui design-a11y: field border, focus ring, placeholder, error text', () => {
  const portal = fs.readFileSync(PORTAL_CSS, 'utf8');

  it('--field-border and --focus are defined in both themes', () => {
    for (const sel of [':root', ':root[data-theme="dark"]']) {
      const p = palette(portal, sel);
      expect(p['field-border']).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p['focus']).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('non-text pairs hold their own minimum — light', () => {
    expect(checkMin('portal light', portal, ':root', DA_BOTH)).toEqual([]);
  });

  it('non-text pairs hold their own minimum — dark', () => {
    expect(checkMin('portal dark', portal, ':root[data-theme="dark"]', [...DA_BOTH, ...DA_DARK_ONLY])).toEqual([]);
  });

  it('a 3:1 pair is NOT held to 4.5 (the per-pair minimum is real)', () => {
    // --field-border is 3.29:1 on --surface-card in light: it must pass at 3 and would fail at 4.5.
    const p = palette(portal, ':root');
    const r = ratio(p['field-border'], p['surface-card']);
    expect(r).toBeGreaterThanOrEqual(UI_MIN);
    expect(r).toBeLessThan(AA);
  });

  it('the old border colour really did fail, so this guard has something to catch', () => {
    const p = palette(portal, ':root');
    expect(ratio(p['hairline'], p['canvas'])).toBeLessThan(UI_MIN);
  });

  it('every input-like control draws its border with --field-border, not --hairline', () => {
    for (const sel of ['.form-group select', '.composer', '.folder-form input', '.conv-move', '.report-opt', '.report-note textarea']) {
      expect(ruleBody(portal, sel)).toContain('var(--field-border)');
    }
  });

  it('the base rules that apply the tokens are present', () => {
    expect(ruleBody(portal, ':focus-visible')).toContain('var(--focus)');
    // Placeholder pairs (--muted on canvas / soft / card, both themes) are already pinned in PORTAL_PAIRS above.
    expect(ruleBody(portal, '::placeholder')).toContain('var(--muted)');
    expect(ruleBody(portal, '.error-msg')).toContain('var(--error-text)');
    expect(ruleBody(portal, '[hidden]')).toMatch(/display:\s*none\s*!important/);
    expect(portal).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none\s*!important/);
  });
});
