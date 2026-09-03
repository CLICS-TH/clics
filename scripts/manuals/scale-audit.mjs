#!/usr/bin/env node
/*
 * Does the manual's type hierarchy survive every viewport, in both consoles?
 *
 * WHY THIS IS NOT COVERED BY THE OTHER GATES. test:readability checks contrast, the 12px Thai floor
 * and clipping; test:responsive checks overflow and tap targets. Neither compares one text role
 * against another, so a page where the sub-heading ends up SMALLER than the paragraph it heads
 * passes both — every individual size is legible, the hierarchy is simply inverted.
 *
 * THE SPECIFIC HAZARD. The two consoles scale desktop type in incompatible ways:
 *
 *   physician-ui    `body { font-size: 22px }` at >=1280px    -- scales BODY, so `rem` does NOT
 *                                                                follow (rem tracks <html>)
 *   audit-dashboard `html { font-size: 118/132/145% }`        -- scales ROOT, so `rem` DOES follow
 *
 * Any size written in px is frozen in both. Mix px and rem in one document and the ratios between
 * them change with the viewport — which is exactly how a heading and its body text swap places.
 * The defect this was written for: h3 rendering 17px inside 22px body at 1280px in the portal.
 *
 *   node scripts/manuals/scale-audit.mjs
 *   DASH_URL=http://localhost:3000 node scripts/manuals/scale-audit.mjs
 *
 * Exit 0 = the hierarchy holds at everything MEASURED — read the coverage line, it names what ran.
 * Exit 1 = an inversion, a Thai-floor breach, or a role the gate could no longer measure.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const PORTAL = new URL('../../physician-ui/public', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DASH = process.env.DASH_URL;

// The common laptop range (1280-1600) is where both apps step up, so it is sampled densely.
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1600, 1920, 2560];
const THAI_FLOOR = 12;

/*
 * Every text role, and the rule it must satisfy.
 *
 * `rel` names the role each is compared against, and it is NOT always body. A number that sits on
 * a heading is governed by that heading's scale, not by the paragraph three lines below it: with
 * everything measured against body, a 15px section number frozen beside a 44px heading — verbatim
 * the defect this gate exists for — still cleared its body ratio and reported green.
 *
 * `probe` separates a block this document does not contain from a selector that has broken. It has
 * to be structurally INDEPENDENT of the role selector or it breaks in the same edit and the role
 * goes quietly unmeasured: figcap probes `img`, because a screenshot is present or absent
 * regardless of which element wraps its caption.
 */
const ROLES = [
  { key: 'body',   sel: '.guide-section p:not(.lead)', dash: '[data-role="body"]',
    why: 'the running prose everything else is judged against' },
  { key: 'lead',   sel: '.guide-section p.lead',       dash: '[data-role="lead"]',
    rel: 'body', min: 1.0,  why: 'a lead paragraph must not be smaller than body' },
  { key: 'h2',     sel: '.guide-section > h2',         dash: 'section > h2',
    rel: 'body', min: 1.25, why: 'a section heading must clearly outrank body' },
  { key: 'h1',     sel: '.guide-cover h1',             dash: 'header h1',
    rel: 'h2',   min: 1.05, why: "the manual's own title must outrank its section headings" },
  { key: 'sub',    sel: '.guide-cover .sub',           dash: 'header p[class*="max-w-prose"]',
    rel: 'body', min: 0.82, why: 'the cover subtitle is read once, by everyone' },
  { key: 'h2n',    sel: '.guide-section > h2 .n',      dash: '[data-role="h2num"]',
    rel: 'h2',   min: 0.4,  why: 'the section number sits ON the heading rule and scales with it' },
  { key: 'h3',     sel: '.guide-section h3',           dash: '[data-role="h3"]',
    rel: 'body', min: 1.0,  why: 'a sub-heading must never be SMALLER than the text it heads' },
  { key: 'step',   sel: '.guide ol.steps > li',        dash: '[data-role="step"]',
    rel: 'body', min: 0.9,  why: 'step text is primary content' },
  { key: 'stepn',  sel: null,                          dash: '[data-role="stepnum"]',
    rel: 'step', min: 0.62, why: "the step counter is the reader's place in the sequence" },
  { key: 'bullet', sel: '.guide ul.bullets > li',      dash: '[data-role="bullet"]',
    rel: 'body', min: 0.9,  why: 'bullet text is primary content' },
  { key: 'chip',   sel: '.guide .chip',                dash: '[data-role="chip"]',
    rel: 'body', min: 0.72, why: 'a quoted UI label must stay readable beside its sentence' },
  { key: 'callout',sel: '.guide .callout',             dash: '[data-role="callout"]',
    rel: 'body', min: 0.9,  why: 'callout body is primary content' },
  { key: 'kind',   sel: '.guide .callout .kind',       dash: '[data-role="kind"]',
    rel: 'callout', min: 0.62, why: 'the callout kind label carries severity' },
  { key: 'toc',    sel: '.guide-toc a',                dash: '[data-role="toc"]',
    rel: 'body', min: 0.72, why: 'the contents list is a navigation target' },
  { key: 'tocn',   sel: '.guide-toc .n',               dash: '[data-role="tocnum"]',
    rel: 'toc',  min: 0.8,  why: 'the contents number is the anchor a reader scans down' },
  { key: 'table',  sel: '.guide table td',             dash: '[data-role="table"] td',
    rel: 'body', min: 0.78, why: 'the rubric table is the densest content in the manual' },
  { key: 'figcap', sel: '.guide figcaption',           dash: '[data-role="figcap"]', probe: 'img',
    rel: 'body', min: 0.68, why: 'a caption explains the screenshot above it' },
];

/*
 * KNOWN, CONSIDERED EXEMPTIONS — written down so they read as decisions and not as gaps.
 *
 * h3 vs lead. `lead` reaches 1.25em while `h3` is 1.0625em, so a lead paragraph is larger than a
 *   sub-heading. Deliberate, and not an inversion any reader meets: `lead` is a section's opening
 *   sentence and `h3` heads a later subsection, so the two are never adjacent. h3 is checked
 *   against the body prose it actually sits above, which it outranks at every width.
 *
 * The portal's step counter is a ::before pseudo-element, which querySelectorAll cannot reach, so
 *   `stepn` is measured on the dashboard only. Its portal twin is guide.css
 *   `.guide ol.steps > li::before`; if that is changed back to px this gate will NOT catch it.
 *   Printed in the coverage line rather than left implicit.
 *
 * Theme is not varied. Computed font-size does not depend on theme, so a second pass would double
 *   the runtime for no signal. Contrast and painted backgrounds belong to test:readability, which
 *   does cover both themes.
 */

function serve() {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    let f = join(PORTAL, p.replace(/^\/+/, '')); if (!extname(f)) f += '.html';
    try { res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); }
    catch { res.writeHead(404).end('nf'); }
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

/**
 * Per role: the median size (representative, used for ratios) and the smallest (used for the Thai
 * floor). Median alone let a single undersized element of a role sit below the floor unreported.
 */
const MEASURE = (roles) => {
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  // offsetParent is null for `position: fixed` and under a `display: contents` ancestor, neither of
  // which means invisible. Check the painted box instead.
  const shown = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const out = {};
  for (const r of roles) {
    if (!r.sel) { out[r.key] = { state: 'no-selector' }; continue; }
    const els = [...document.querySelectorAll(r.sel)].filter((e) => shown(e) && e.textContent.trim());
    if (!els.length) {
      out[r.key] = { state: r.probe && !document.querySelector(r.probe) ? 'absent' : 'missing' };
      continue;
    }
    const sizes = els.map(px).sort((a, b) => a - b);
    out[r.key] = { state: 'ok', n: sizes.length, min: sizes[0], med: sizes[Math.floor(sizes.length / 2)] };
  }
  out._root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  out._body = parseFloat(getComputedStyle(document.body).fontSize);
  return out;
};

const findings = [];
const rows = [];
const covered = [];

async function run(browser, label, url, langs) {
  for (const lang of langs) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      if (lang === 'en') await ctx.addInitScript(() => localStorage.setItem('clics_manual_lang', 'en'));
      const pg = await ctx.newPage();
      try {
        await pg.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await pg.evaluate(() => document.fonts.ready);

        // The English half of the matrix is only worth anything if English actually rendered.
        // Without this the run measures Thai twice and reports twice the coverage it has.
        if (lang === 'en') {
          const isEn = await pg.evaluate(() => document.documentElement.dataset.manualLang === 'en');
          if (!isEn) {
            findings.push({ kind: 'COVERAGE', label, lang, w, role: '-',
              detail: 'the English pass did not switch language — half the matrix would be Thai measured twice' });
            await ctx.close();
            continue;
          }
        }

        // Each app gets its own selector set: the portal styles the manual through semantic
        // classes, the dashboard carries data-role for exactly this purpose.
        const m = await pg.evaluate(MEASURE,
          ROLES.map((r) => ({ ...r, sel: label === 'dashboard' ? r.dash : r.sel })));
        rows.push({ label, lang, w, root: m._root, body: m._body, m });

        for (const r of ROLES) {
          const v = m[r.key];
          if (v.state === 'no-selector' || v.state === 'absent') continue;
          if (v.state === 'missing') {
            findings.push({ kind: 'UNMEASURED', label, lang, w, role: r.key,
              detail: `"${label === 'dashboard' ? r.dash : r.sel}" matched no visible element, but the `
                + 'block it measures IS on the page — the gate has stopped covering this role' });
            continue;
          }
          if (v.min < THAI_FLOOR) {
            findings.push({ kind: 'THAI-FLOOR', label, lang, w, role: r.key,
              detail: `smallest of ${v.n} is ${v.min}px, below the ${THAI_FLOOR}px floor` });
          }
          if (r.min == null) continue;

          // Judged against its OWN parent scale, which is not always body.
          const base = m[r.rel];
          if (!base || base.state !== 'ok') {
            findings.push({ kind: 'UNMEASURED', label, lang, w, role: r.key,
              detail: `cannot be judged: its reference role "${r.rel}" is ${base ? base.state : 'undefined'}` });
            continue;
          }
          const ratio = v.med / base.med;
          if (ratio < r.min) {
            findings.push({ kind: 'HIERARCHY', label, lang, w, role: r.key,
              detail: `${v.med}px vs ${base.med}px ${r.rel} (ratio ${ratio.toFixed(2)}, need >=${r.min}) — ${r.why}` });
          }
        }
        if (m.h2.state === 'ok' && m.h3.state === 'ok' && m.h2.med <= m.h3.med) {
          findings.push({ kind: 'HIERARCHY', label, lang, w, role: 'h2/h3',
            detail: `h2 ${m.h2.med}px <= h3 ${m.h3.med}px — the two heading levels are indistinguishable` });
        }
      } catch (e) {
        findings.push({ kind: 'ERROR', label, lang, w, role: '-', detail: e.message.slice(0, 140) });
      }
      await ctx.close();
    }
    const got = rows.filter((r) => r.label === label && r.lang === lang).length;
    if (got === 0) {
      findings.push({ kind: 'COVERAGE', label, lang, w: 0, role: '-',
        detail: `not one of ${WIDTHS.length} renders produced a measurement — the target was `
          + 'unreachable or rendered nothing. This pass measured NOTHING.' });
    }
    covered.push(`${label}/${lang}:${got}/${WIDTHS.length}`);
  }
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
await run(browser, 'portal', `${base}/manual`, ['th', 'en']);
if (DASH) await run(browser, 'dashboard', `${DASH}/manual`, ['th', 'en']);
else if (process.env.REQUIRE_DASH === '1') {
  findings.push({ kind: 'COVERAGE', label: 'dashboard', lang: '-', w: 0, role: '-',
    detail: 'REQUIRE_DASH=1 but DASH_URL is unset or empty — the dashboard half did not run' });
}
await browser.close(); server.close();

// ---- report --------------------------------------------------------------------------------------
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const COLS = ['h1', 'h2', 'h2n', 'h3', 'lead', 'chip', 'kind', 'toc', 'table'];
const cell = (v) => (v && v.state === 'ok' ? String(Math.round(v.med * 100) / 100) : '·');

console.log(`\n${C.b}Measured type scale${C.x}  ${rows.length} viewport renders\n`);
console.log(C.d + ['app', 'lang', 'width', 'root', 'body', ...COLS].map((h) => h.padStart(8)).join('') + C.x);
for (const r of rows) {
  if (r.lang !== 'th') continue;   // the en pass is asserted, not printed; this table is a sanity read
  console.log([r.label.slice(0, 7), r.lang, r.w, r.root, r.body, ...COLS.map((k) => cell(r.m[k]))]
    .map((c) => String(c ?? '·').padStart(8)).join(''));
}

// Say exactly what ran. A success line that overstates its coverage is worse than none: it is the
// sentence a reviewer quotes when deciding they do not need to look.
const gaps = ['theme not varied (font-size is theme-independent; contrast is test:readability)',
  'portal step counter is a ::before and cannot be selected — measured on the dashboard only'];
if (!DASH) gaps.unshift('dashboard NOT measured — set DASH_URL to a running server to include it');

console.log(`\n${C.d}coverage: ${covered.join(', ') || 'nothing'} × ${WIDTHS.length} widths × ${ROLES.length} roles${C.x}`);
for (const g of gaps) console.log(`${C.y}  ! ${g}${C.x}`);

if (!findings.length) {
  console.log(`\n${C.g}✓${C.x} type hierarchy holds at everything measured above\n`);
  process.exit(0);
}
console.log('');
const seen = new Set();
for (const f of findings) {
  const k = `${f.kind}|${f.label}|${f.role}|${f.detail}`;
  if (seen.has(k)) continue; seen.add(k);
  const widths = findings.filter((g) => g.kind === f.kind && g.role === f.role && g.label === f.label && g.detail === f.detail).map((g) => g.w);
  console.log(`${C.r}✗${C.x} ${C.b}${f.kind}${C.x} ${f.label}/${f.role} @ ${[...new Set(widths)].join(', ')}px\n  ${f.detail}`);
}
console.log(`\n${C.r}${C.b}${seen.size} distinct finding(s).${C.x}\n`);
process.exit(1);
