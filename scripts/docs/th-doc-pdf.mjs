#!/usr/bin/env node
/*
 * Render ONE Thai markdown document to an A4 PDF.
 *
 * Split out of scripts/probe/report/methodology-pdf.mjs rather than copied: that script renders a
 * specific bilingual pair and hard-codes both halves, so a second document could not use it. What
 * both need is the same three things — the committed markdown converter, Thai type at a readable
 * size, and the guards. Those live here; methodology-pdf.mjs keeps its own bilingual layout.
 *
 * The two guards are the reason this is a script and not a shell one-liner:
 *   - the Thai face must actually resolve. A silent fallback prints detached vowels and tone marks,
 *     which is invisible in the HTML and fatal in the PDF, so it fails the build instead.
 *   - nothing may run off the page box. Reported per element rather than discovered by a reader.
 *
 * Usage:  node scripts/docs/th-doc-pdf.mjs <in.md> --out <path.pdf> [--title "..."]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const argOf = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };

const SRC = process.argv[2];
if (!SRC || SRC.startsWith('--')) {
  console.error('\n  usage: node scripts/docs/th-doc-pdf.mjs <in.md> --out <path.pdf> [--title "..."]\n');
  process.exit(1);
}
const IN = path.resolve(ROOT, SRC);
if (!existsSync(IN)) { console.error(`\n  FAIL: missing source — ${SRC}\n`); process.exit(1); }

const OUT = path.resolve(ROOT, argOf('out', IN.replace(/\.md$/, '.pdf')));
const TITLE = argOf('title', path.basename(IN, '.md'));

const tmp = path.join(tmpdir(), `clics-thdoc-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Reuse the committed converter — a second markdown implementation would be a second thing to keep correct.
const htmlFile = path.join(tmp, 'doc.html');
execFileSync('node', [path.join(ROOT, 'scripts/docs-to-pdf.js'), IN, htmlFile], { stdio: 'pipe' });
const raw = readFileSync(htmlFile, 'utf8');
const body = (raw.match(/<body>([\s\S]*)<\/body>/) || [])[1];
if (!body) { console.error(`\n  FAIL: no <body> in the HTML generated from ${SRC}\n`); process.exit(1); }
const baseStyle = (raw.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

// docs-to-pdf.js sets 10pt for a mixed-language document. Thai at 10pt in a narrow face is below
// this project's readable floor (>=11.5pt body), so the whole document steps up and the stack is
// pinned rather than inherited — the size below is only predictable if the face is known.
const OVERRIDES = `
body { font-family: "TH Sarabun New", "Sukhumvit Set", "Noto Sans Thai", sans-serif;
       font-size: 13.5pt; line-height: 1.45; }
table { font-size: 12.5pt; table-layout: auto; max-width: 100%; }
/* Menlo before SF Mono: SF Mono's hyphen is long enough at this size that "--name" reads as an
   en dash, and a retyped flag is a support call. The PDF text keeps U+002D either way. */
code, pre { font-size: 11pt; font-family: Menlo, "DejaVu Sans Mono", Consolas, monospace; }
/* A heading must not break a token: "cme-dev" wrapping after the hyphen looks like a typo. */
h1 code, h2 code, h3 code { white-space: nowrap; overflow-wrap: normal; }
h1 { font-size: 22pt; } h2 { font-size: 16pt; } h3 { font-size: 14pt; }
td, th { overflow-wrap: anywhere; }
table.wide { font-size: 10.5pt; }
pre, code { overflow-wrap: anywhere; white-space: pre-wrap; }
h2, h3 { break-after: avoid; }
table, blockquote, pre { break-inside: avoid; }
`;

writeFileSync(path.join(tmp, 'final.html'),
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>${baseStyle}${OVERRIDES}</style></head><body>${body}</body></html>`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + path.join(tmp, 'final.html'), { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

// Step down only the tables that would otherwise exceed the text column, rather than shrinking all of them.
const widened = await page.evaluate(() => {
  let n = 0;
  for (const t of document.querySelectorAll('table')) {
    if (t.scrollWidth > t.parentElement.clientWidth + 1) { t.classList.add('wide'); n++; }
  }
  return n;
});

const font = await page.evaluate(() => {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:80px;';
  probe.textContent = 'ทดสอบภาษาไทย';
  document.body.appendChild(probe);
  probe.style.fontFamily = 'monospace'; const w0 = probe.offsetWidth;
  probe.style.fontFamily = '"TH Sarabun New", monospace'; const w1 = probe.offsetWidth;
  probe.remove();
  return { differs: w0 !== w1, w0, w1 };
});
if (!font.differs) {
  await browser.close();
  console.error(`\n  FAIL: "TH Sarabun New" did not resolve — this would print in a fallback face.`);
  console.error(`  monospace width ${font.w0}px === TH Sarabun width ${font.w1}px\n`);
  process.exit(1);
}

const overflow = await page.evaluate(() => {
  const limit = document.body.clientWidth + 1;
  return [...document.querySelectorAll('table, pre, p, li')]
    .filter((el) => el.scrollWidth > limit)
    .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent.trim().slice(0, 60)}`);
});

mkdirSync(path.dirname(OUT), { recursive: true });
await page.pdf({ path: OUT, format: 'A4', printBackground: true,
  margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
await browser.close();

console.log(`  Thai face resolved (${font.w0}px → ${font.w1}px)`);
console.log(`  ${widened} table(s) stepped down to fit the text column`);
if (overflow.length) {
  console.log(`\n  ⚠ ${overflow.length} element(s) still wider than the page box:`);
  overflow.slice(0, 8).forEach((o) => console.log(`      ${o}`));
}
console.log(`  wrote ${path.relative(ROOT, OUT)}`);
