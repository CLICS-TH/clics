#!/usr/bin/env node
/*
 * The A4 handouts — rendered from the SAME source as the in-console manuals.
 *
 * WHY THIS REPLACES THE OLD PIPELINE. scripts/manuals/generate.mjs rendered three hand-written HTML
 * files in docs/manuals/source/. Those files were the source, so the print and screen manuals were
 * two bodies of prose, and they drifted: the committed PDFs sat two months behind the product with
 * nothing to signal it. Here the markdown in docs/manuals/content/ is the only source, the print
 * page is generated from it, and @media print in physician-ui/public/css/guide.css is the only thing
 * that differs — so a handout cannot say something the console manual does not.
 *
 *   node scripts/manuals/pdf.mjs                 # every manual, every language
 *   node scripts/manuals/pdf.mjs physician th    # just one
 *
 * Needs Playwright's Chromium (npx playwright install chromium). Kept out of `npm run test:manuals`
 * deliberately: that gate is hermetic and browserless so it can run on every push, and a PDF is a
 * publishing step, not a check.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseManual } from './lib/parse.mjs';
import { renderBody, renderToc, esc } from './lib/render-html.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORTAL = join(ROOT, 'physician-ui/public');
// Figures are served from the SOURCE directory, not from either console's copy of them. build.mjs
// now ships each manual only the frames it references, so the auditor's frame lives under
// audit-dashboard/public/ and the physician's under physician-ui/public/ — a print server that
// looked in one of those printed the other manual's figures as empty boxes. The source directory
// is the one place that has all of them.
const IMG_SRC = join(ROOT, 'docs/manuals/source/img');
const OUT = join(ROOT, 'docs/manuals');
const MIME = { '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

const TITLES = {
  physician: { th: 'คู่มือแพทย์ผู้ใช้งาน', en: 'Physician user manual' },
  auditor: { th: 'คู่มือผู้ตรวจประเมิน', en: 'Auditor manual' },
};
const SUBS = {
  physician: {
    th: 'ตั้งแต่เข้าสู่ระบบจนได้รับผลการประเมิน',
    en: 'From signing in to receiving your result',
  },
  auditor: {
    th: 'ตั้งแต่คิวการประเมินจนถึงการเปิดเผยคะแนน AI',
    en: 'From your queue to the reveal',
  },
};

/**
 * The print document.
 *
 * Only ONE language, unlike the console page — a handout is printed, and a reader cannot press a
 * toggle on paper. That is also why the existing three PDFs were each single-language.
 */
function printPage(name, lang, sections) {
  return `<!DOCTYPE html>
<html lang="${lang}" data-manual-lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>CLICS — ${esc(TITLES[name][lang])}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Noto+Serif+Thai:wght@500;600&family=Inter:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
  <link rel="stylesheet" href="/css/guide.css" />
</head>
<body>
  <div class="container guide">
    <header class="page-intro guide-cover">
      <p class="eyebrow">CLICS · Continuous Learning &amp; Intelligence Credit System</p>
      <h1>${esc(TITLES[name][lang])}</h1>
      <p class="sub">${esc(SUBS[name][lang])}</p>
    </header>
    ${renderToc(sections, lang, lang === 'en' ? 'Contents' : 'สารบัญ')}
${renderBody(sections, lang)}
  </div>
</body>
</html>
`;
}

/** Serves the generated pages from memory and everything else (css, images) from the portal. */
function startServer(pages) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pages.has(path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages.get(path));
    }
    try {
      const rel = path.replace(/^\/+/, '');
      const body = path.startsWith('/img/manual/')
        ? await readFile(join(IMG_SRC, path.slice('/img/manual/'.length)))
        : await readFile(join(PORTAL, rel));
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wantName = argv[0];
const wantLang = argv[1];

const pages = new Map();
const jobs = [];
/** file -> what the SOURCE says should render, asserted against what actually renders visible. */
const expected = {};

for (const name of ['physician', 'auditor']) {
  if (wantName && name !== wantName) continue;
  const read = async (l) => readFile(join(ROOT, `docs/manuals/content/${name}.${l}.md`), 'utf8').catch(() => null);
  const th = await read('th');
  if (!th) continue;
  const m = parseManual({ th, en: await read('en'), name });

  for (const lang of ['th', 'en']) {
    if (!m[lang]) continue;
    if (wantLang && lang !== wantLang) continue;
    // Absolute, so the print page resolves images exactly as the console page does.
    for (const s of m[lang]) {
      for (const b of s.blocks) if (b.t === 'figure' && !b.src.startsWith('/')) b.src = `/img/manual/${b.src.split('/').pop()}`;
    }
    const file = `clics-${name}-manual-${lang}`;
    pages.set(`/${file}.html`, printPage(name, lang, m[lang]));
    expected[file] = {
      sections: m[lang].length,
      figures: m[lang].reduce((n, sec) => n + sec.blocks.filter((b) => b.t === 'figure').length, 0),
    };
    jobs.push(file);
  }
}

if (!jobs.length) { console.error('Nothing to render — check docs/manuals/content/.'); process.exit(2); }

await mkdir(OUT, { recursive: true });
const server = await startServer(pages);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  for (const file of jobs) {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/${file}.html`, { waitUntil: 'networkidle', timeout: 30000 });
      // Thai renders as tofu if the PDF is captured before the webfonts land. This is the single
      // most important line in the file.
      await page.evaluate(() => document.fonts.ready);
      await page.emulateMedia({ media: 'print' });
      // The screenshots are `loading="lazy"`, which is right on screen and wrong here: a PDF has no
      // viewport to scroll, so every figure below the first fold was never fetched and printed as
      // an empty box under its caption. Force them eager and WAIT for the decode — networkidle
      // does not cover an image the browser has decided not to request yet.
      await page.evaluate(async () => {
        for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      });

      // WHAT THIS GUARD IS FOR. A blank or gutted PDF is invisible downstream: the file exists,
      // opens, and carries the right cover. Both defects it now covers shipped once — the English
      // handouts rendered with zero sections, and every handout rendered with no contents page
      // because the print rule hid `nav` and the contents list IS a nav. So it asserts on the
      // three things a reader would notice missing, not just on the sections.
      const seen = await page.evaluate(() => {
        const shown = (e) => e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null;
        return {
          sections: [...document.querySelectorAll('.guide-section')].filter(shown).length,
          toc: [...document.querySelectorAll('.guide-toc a')].filter(shown).length,
          images: document.images.length,
          broken: [...document.images].filter((i) => !i.naturalWidth).length,
        };
      });
      const want = expected[file];
      if (seen.sections !== want.sections) {
        throw new Error(
          `${file}: ${seen.sections} of ${want.sections} sections visible. If 0, check that <html> `
          + 'carries data-manual-lang — that is what guide.css keys the language switch on.',
        );
      }
      if (seen.toc !== want.sections) {
        throw new Error(
          `${file}: contents list has ${seen.toc} visible entries, expected ${want.sections}. `
          + 'The @media print rule must not hide nav.guide-toc.',
        );
      }
      if (seen.images !== want.figures || seen.broken) {
        throw new Error(
          `${file}: ${seen.images} images rendered (expected ${want.figures}), ${seen.broken} of `
          + 'them broken or undecoded. A figure that never loaded prints as an empty box.',
        );
      }
      await page.pdf({
        path: join(OUT, `${file}.pdf`),
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '15mm', left: '13mm', right: '13mm' },
      });
      console.log(`  ✓ docs/manuals/${file}.pdf`);
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  server.close();
}
