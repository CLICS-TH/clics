// Source-level guards for the design-a11y rules a component test cannot see — each is a pattern that
// compiles, renders and looks fine in a screenshot and is still wrong:
//
//   text-primary as SMALL text   bright coral is 3.11:1 on the light canvas and 2.71:1 on --secondary;
//                                small text must use text-link (or text-coral-on-tint on a tint)
//   text-[10px] / text-[11px]    below the Thai small-text floor (text-xs is 13px here)
//   text-[Npx] of any size       frozen against the root scale and the text-sm body floor
//   a raw <table> in a page that was migrated to ui/table (labelled scroll region, scope, numerics)
//   text on solid bg-primary     white on bright coral is 3.28:1; a filled control uses bg-coral-active
//
// Line-based, so a className split across lines can escape it; that is a limit of the technique, not
// a licence — write the class on one line.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

function files(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, acc);
    else if (/\.tsx$/.test(p)) acc.push(p);
  }
  return acc;
}
const SOURCES = [...files(join(ROOT, 'app')), ...files(join(ROOT, 'components'))];
const lines = (f: string) => readFileSync(f, 'utf8').split('\n');
const rel = (f: string) => relative(ROOT, f);

describe('design-a11y source guards', () => {
  it('no small text is coloured with bright coral (text-primary)', () => {
    const bad: string[] = [];
    for (const f of SOURCES) {
      lines(f).forEach((l, i) => {
        // `text-primary` as a colour class — not text-primary-foreground, not hover:/dark: variants of other tokens.
        if (!/(^|[\s"'`])text-primary(?![-\w/])/.test(l)) return;
        // Large text (>= 24px) is held to 3:1, which 3.11:1 clears on the canvas. Only there: on
        // --secondary it is 2.71:1, so a large coral figure on a hover:bg-secondary surface must swap
        // to text-coral-on-tint while hovered (StatStrip does; contrast.test.ts pins the pair). This
        // line-based check cannot see a hover surface set on another element, so that stays manual.
        if (/\btext-(2xl|3xl|4xl|5xl|6xl|display|fluid-xl|fluid-2xl)\b/.test(l)) return;
        // Small: an explicit small size on the same line.
        if (/\btext-(xs|sm|base|\[1\dpx\])\b/.test(l)) bad.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('nothing is set below the small-text floor', () => {
    // The Latin-only is_test tag on admin/ples was exempt at 10px; it is text-xs now, so nothing is.
    const bad: string[] = [];
    for (const f of SOURCES) {
      lines(f).forEach((l, i) => {
        if (!/text-\[(9|10|11)px\]/.test(l)) return;
        bad.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('no font size is written in px', () => {
    // A px size is frozen. It does not follow the 118/132/145% desktop root, and it dodges the
    // width-scoped text-sm body floor in globals.css. Both hits this was written for were Thai body
    // text under 15.33px on a phone: the AI-reply table (13px) and its h2 (15px, smaller than the
    // paragraph under it). Use a token (text-xs / text-sm / text-base ...) or an em step of one.
    // Covered: text-[13px], text-[length:13px] (any variant prefix), and a JSX style attribute whose
    // fontSize is a number (React reads it as px) or a '…px' string. Exempt: a px FLOOR inside
    // max()/min()/clamp() — text-[length:max(0.8em,12px)] follows its parent and only stops it
    // falling below 12px. A size held in a variable (ClicsLogo's `fontSize: size`) and a style object
    // split across lines are out of reach of a line scan.
    const TW_PX = /(^|[\s"'`:])text-\[(length:)?\d+(\.\d+)?px\]/;
    const STYLE_PX = /\bstyle=\{\{.*?\bfontSize:\s*(\d+(?:\.\d+)?\s*(?=[,}])|(['"`])(?:(?!\2).)*?px\2)/;
    const bad: string[] = [];
    for (const f of SOURCES) {
      lines(f).forEach((l, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(l)) return;   // prose about a class, not a class
        const style = STYLE_PX.exec(l);
        if (TW_PX.test(l) || (style && !/\b(max|min|clamp)\(/.test(style[1]))) {
          bad.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('no text is painted on a solid bg-primary fill', () => {
    // --primary is the bright accent (non-text). White on it is 3.28:1, and the shadcn habit of pairing
    // bg-primary with text-primary-foreground is how the overview's Download button shipped at that
    // ratio. Filled controls take bg-coral-active, whose pair with --primary-foreground is pinned in
    // contrast.test.ts. Untexted fills (switch tracks, meters, the slider range) and /NN tints stay fine.
    const bad: string[] = [];
    for (const f of SOURCES) {
      lines(f).forEach((l, i) => {
        if (!/(^|[\s"'`:])bg-primary(?![-\w/])/.test(l)) return;
        if (/\btext-(primary-foreground|white)\b/.test(l)) bad.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('pages migrated to ui/table keep no raw <table>', () => {
    const migrated = ['app/admin/ples/page.tsx', 'app/admin/compensation/page.tsx', 'components/RaterSpread.tsx'];
    const bad = migrated.filter((f) => /<table[\s>]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(bad).toEqual([]);
  });

  it('the AI colour tokens are only used where the AI wrote the content', () => {
    // --ai-* means "an AI produced this". Allowed homes: the AiOutput primitive, the Badge tone, and
    // the AI score block. Anywhere else it would dilute the signal (peer = violet, human = coral).
    const allowed = ['components/ui/ai-output.tsx', 'components/ui/badge.tsx'];
    const bad: string[] = [];
    for (const f of SOURCES) {
      if (allowed.includes(rel(f))) continue;
      lines(f).forEach((l, i) => {
        if (/(bg|text|border)-ai-(bg|text|border)/.test(l)) bad.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
