// Every project colour token a component names as a utility must be mapped in @theme inline.
//
// This exists because of a bug that shipped and looked fine. Tailwind v4 generates `text-danger`
// ONLY from a `--color-danger` entry in @theme inline; the raw `--danger` variable is not enough.
// Without the mapping the class still lands in the DOM and simply applies no colour — so a status
// indicator renders in plain body text and every screenshot, typecheck, lint and component test
// still passes. The component test that was supposed to catch it asserted the CLASS NAME, which is
// present either way.
//
// A non-compiling token is indistinguishable from a working one by eye. This is the check that can
// tell them apart, and it only looks at names that ARE project tokens, so Tailwind's own palette
// (text-white, bg-muted/40, text-xs) cannot produce a false positive.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');

const themeBlock = css.slice(css.indexOf('@theme inline'), css.indexOf('}', css.indexOf('@theme inline')));
const mapped = new Set([...themeBlock.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// Tokens the project defines outside the theme block — the candidates for this mistake.
const defined = new Set([...css.matchAll(/^\s*--([a-z0-9-]+)\s*:\s*#/gm)].map((m) => m[1]));

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.tsx$/.test(p)) acc.push(p);
  }
  return acc;
}

describe('@theme inline', () => {
  it('maps every project colour token that a component uses as a utility', () => {
    const unmapped: string[] = [];
    for (const file of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))]) {
      const body = readFileSync(file, 'utf8');
      for (const m of body.matchAll(/\b(?:text|bg|border|ring|fill|stroke)-([a-z][a-z0-9-]*)(?:\/\d+)?\b/g)) {
        const token = m[1];
        // Only names the project actually defines as a colour. Anything else is Tailwind's own.
        if (!defined.has(token) || mapped.has(token)) continue;
        unmapped.push(`${file.slice(ROOT.length + 1)} uses "${m[0]}" but @theme inline has no --color-${token}`);
      }
    }
    expect([...new Set(unmapped)]).toEqual([]);
  });

  it('defines every mapped colour in BOTH themes, so no utility is theme-blind', () => {
    // A token defined only in :root renders the light value on a dark ground; only in .dark and it
    // is undefined in light. Either way the failure is silent.
    // Anchored to the SELECTOR, not the first ".dark" substring — the word appears in prose above it,
    // which silently truncated the light half and made this test report a failure that was its own.
    const at = css.search(/^\.dark\s*\{/m);
    expect(at).toBeGreaterThan(0);
    const light = css.slice(0, at);
    const dark = css.slice(at);
    const missing: string[] = [];
    for (const token of ['ok', 'danger']) {
      if (!new RegExp(`--${token}\\s*:`).test(light)) missing.push(`--${token} missing from :root`);
      if (!new RegExp(`--${token}\\s*:`).test(dark)) missing.push(`--${token} missing from .dark`);
    }
    expect(missing).toEqual([]);
  });
});

// The text-sm body floor (globals.css, "Body-text floor") overrides the --text-sm VARIABLE below
// 1280px. That reaches `.text-sm` only while Tailwind emits it as `font-size: var(--text-sm)`, which
// it does for a default-theme value and does NOT for one declared in @theme inline (inline bakes the
// literal into the utility, the way .text-xs ships). Declaring --text-sm in the inline block, as the
// --text-xs line beside it invites, would silently put Thai body text back to 14px on every phone.
// The rendered value is measured by scripts/readability/audit.mjs; this pins the cause.
describe('text-sm body floor', () => {
  const inline = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

  it('keeps --text-sm out of @theme inline, so the width-scoped override can reach .text-sm', () => {
    expect(inline).toContain('--text-xs:');           // the parse found the real block
    expect(inline).not.toMatch(/^\s*--text-sm(--line-height)?\s*:/m);
  });

  it('raises --text-sm to 0.96rem with a Thai-safe line-height below 1280px only', () => {
    const rule = /@media \(width < 1280px\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/--text-sm:\s*0\.96rem;/);
    expect(rule).toMatch(/--text-sm--line-height:\s*1\.5;/);
    // The >=1280 root step it is scoped against must still be there, or 0.875rem is 14px again.
    expect(css).toMatch(/@media \(min-width: 1280px\) \{ html \{ font-size: 118%; \} \}/);
  });
});
