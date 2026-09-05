#!/usr/bin/env node
/*
 * Render docs/METHODOLOGY-local-vs-sonnet.{en,th}.md to one A4 PDF.
 *
 * This script exists because the two Manuscript PDFs that preceded it were rendered from HTML
 * hand-authored in an ephemeral session scratchpad under /private/tmp. Those sources are already
 * unreachable, so neither PDF can be regenerated or corrected. A deliverable that feeds a paper
 * needs a generator in the repository, not a recipe someone remembers.
 *
 * Layout: English first, then Thai, with a hard page break between. They are the same document in
 * two languages, not two documents — a reader needs one file, and interleaving section by section
 * would break every table across a language boundary.
 *
 * Markdown -> HTML is delegated to the committed scripts/docs-to-pdf.js rather than reimplemented.
 * That converter already handles the block types these documents use (tables, blockquotes, fenced
 * code, lists) and a third markdown implementation in this repo would be a third thing to keep
 * correct. Its stylesheet is then overridden here for two things it was not written for:
 *
 *   1. Thai body type. docs-to-pdf.js sets 10pt for a mixed-language doc; Thai at 10pt in a
 *      narrow face is below the readable floor for this project (>=11.5pt body). The Thai half is
 *      raised, and its font stack is pinned to TH Sarabun New so the size is predictable.
 *   2. Wide tables. The results and variance tables are wider than A4 at the base size, so tables
 *      step down rather than clip. Nothing is allowed to overflow the page box.
 *
 * Usage:  node scripts/probe/report/methodology-pdf.mjs [--out <path.pdf>]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const argOf = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, argOf('out', 'Manuscript/CLICS_Methodology_LocalAI_vs_Sonnet_2026-09-04.pdf'));

const SOURCES = [
  { lang: 'en', file: 'docs/METHODOLOGY-local-vs-sonnet.en.md' },
  { lang: 'th', file: 'docs/METHODOLOGY-local-vs-sonnet.th.md' },
];

// Fail naming the path. A stub would silently ship half a document.
for (const s of SOURCES) {
  const p = path.join(ROOT, s.file);
  if (!existsSync(p)) {
    console.error(`\n  FAIL: missing source — ${s.file}`);
    console.error(`  Both halves are required; this script never renders a partial document.\n`);
    process.exit(1);
  }
}

const tmp = path.join(tmpdir(), `clics-methodology-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Reuse the committed converter, once per language.
const bodies = SOURCES.map(({ lang, file }) => {
  const out = path.join(tmp, `${lang}.html`);
  execFileSync('node', [path.join(ROOT, 'scripts/docs-to-pdf.js'), path.join(ROOT, file), out], { stdio: 'pipe' });
  const html = readFileSync(out, 'utf8');
  const m = html.match(/<body>([\s\S]*)<\/body>/);
  if (!m) { console.error(`\n  FAIL: no <body> in the HTML generated from ${file}\n`); process.exit(1); }
  return { lang, html: m[1] };
});

// docs-to-pdf.js emits its own <style>; take it verbatim and layer the two fixes above on top.
const baseStyle = (readFileSync(path.join(tmp, 'en.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

const OVERRIDES = `
/* --- overrides layered on scripts/docs-to-pdf.js --- */
.half { break-before: page; }
.half:first-of-type { break-before: auto; }

/* Thai needs more point size than Latin at the same optical weight, and TH Sarabun New is narrow.
   Pinned rather than inherited so the size below is predictable; guarded at print time. */
.th, .th p, .th li, .th td, .th th, .th blockquote {
  font-family: "TH Sarabun New", "Sukhumvit Set", "Noto Sans Thai", sans-serif;
}
.th { font-size: 13pt; line-height: 1.42; }
.th table { font-size: 12pt; }
.th code { font-size: 11pt; }
.th h1 { font-size: 21pt; } .th h2 { font-size: 15pt; } .th h3 { font-size: 13.5pt; }

/* Wide tables step down instead of clipping. Nothing may leave the page box. */
table { table-layout: auto; max-width: 100%; }
td, th { overflow-wrap: anywhere; }
table.wide { font-size: 8.5pt; }
.th table.wide { font-size: 10.5pt; }
pre, code { overflow-wrap: anywhere; white-space: pre-wrap; }
h2, h3 { break-after: avoid; }
table, blockquote, pre { break-inside: avoid; }
`;

const doc = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>CLICS — local evaluator screening: methodology</title>
<style>${baseStyle}${OVERRIDES}</style></head><body>
${bodies.map(({ lang, html }) => `<section class="half ${lang}" lang="${lang}">\n${html}\n</section>`).join('\n')}
</body></html>`;

const page1 = path.join(tmp, 'combined.html');
writeFileSync(page1, doc);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + page1, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

// Mark tables that would otherwise exceed the text column, so the step-down rule applies only
// where it is needed rather than shrinking every table in the document.
const widened = await page.evaluate(() => {
  let n = 0;
  for (const t of document.querySelectorAll('table')) {
    if (t.scrollWidth > t.parentElement.clientWidth + 1) { t.classList.add('wide'); n++; }
  }
  return n;
});

// A silent fallback face is the failure this guards: Thai vowels and tone marks detach or render
// as tofu, which is invisible in the HTML and fatal in the PDF.
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
  console.error(`\n  FAIL: "TH Sarabun New" did not resolve — the Thai half would print in a fallback face.`);
  console.error(`  monospace width ${font.w0}px === TH Sarabun width ${font.w1}px`);
  console.error(`  Install the face, or change the stack in OVERRIDES and re-point this guard at it.\n`);
  process.exit(1);
}

// Nothing may run off the page. Catch it here rather than in a printed artefact.
const overflow = await page.evaluate(() => {
  const limit = document.body.clientWidth + 1;
  return [...document.querySelectorAll('table, pre, p, li')]
    .filter((el) => el.scrollWidth > limit)
    .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent.trim().slice(0, 60)}`);
});

mkdirSync(path.dirname(OUT), { recursive: true });
await page.pdf({ path: OUT, format: 'A4', printBackground: true,
  margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
await browser.close();

console.log(`  Thai face resolved (${font.w0}px → ${font.w1}px)`);
console.log(`  ${widened} table(s) stepped down to fit the text column`);
if (overflow.length) {
  console.log(`\n  ⚠ ${overflow.length} element(s) still wider than the page box:`);
  overflow.slice(0, 8).forEach((o) => console.log(`      ${o}`));
}
console.log(`  wrote ${path.relative(ROOT, OUT)}`);
