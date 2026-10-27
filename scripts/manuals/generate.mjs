#!/usr/bin/env node
/*
 * Generate the two Thai CLICS user manuals as PDFs.
 *   1. Capture two screenshots from the PUBLIC (login-free) prod portal pages:
 *        - login card        (https://physician-ui.vercel.app/)
 *        - chat composer      (/guest-chat, textarea pre-filled, NOT sent → no AI spend)
 *   2. Render docs/manuals/source/*.html → docs/manuals/*.pdf with headless Chromium
 *      (page.pdf), waiting for the Noto Thai web fonts to finish loading first.
 *
 * Reuses the tiny static-server idea from scripts/responsive/responsive-smoke.mjs.
 * Run from repo root:  node scripts/manuals/generate.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, 'docs', 'manuals', 'source');
const OUT = join(REPO, 'docs', 'manuals');
const IMG = join(SRC, 'img');
const PORTAL = process.env.PORTAL_BASE || 'https://physician-ui.vercel.app';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.jpg': 'image/jpeg',
};

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const s = await stat(file).catch(() => null);
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Public, login-free pages — capture the real deployed look. Failures are non-fatal: the PDF then
// falls back to the <img> alt text rather than aborting the whole build.
async function captureScreenshots(browser) {
  await mkdir(IMG, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1120, height: 840 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    try {
      await page.goto(`${PORTAL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(IMG, 'login.png') });
      console.log('  ✓ login.png');
    } catch (e) { console.warn('  ⚠ login.png skipped:', e.message); }

    try {
      await page.goto(`${PORTAL}/guest-chat`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1000);
      await page.locator('textarea').first()
        .fill('ผู้ป่วยเจ็บหน้าอกเวลาออกแรง บรรเทาเมื่อพัก ควรเริ่มประเมินอย่างไร?').catch(() => {});
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(IMG, 'guest-composer.png') });
      console.log('  ✓ guest-composer.png');
    } catch (e) { console.warn('  ⚠ guest-composer.png skipped:', e.message); }
  } finally { await ctx.close(); }
}

async function renderPdf(browser, base, name) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/${name}.html`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready); // Thai renders as tofu if we capture before fonts load
    await page.waitForTimeout(400);
    await page.pdf({
      path: join(OUT, `${name}.pdf`),
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '15mm', left: '13mm', right: '13mm' },
    });
    console.log(`  ✓ ${name}.pdf`);
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch();
  try {
    console.log(`Capturing screenshots from ${PORTAL} …`);
    await captureScreenshots(browser);

    console.log('Rendering PDFs …');
    const server = await startServer(SRC);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await renderPdf(browser, base, 'clics-user-guide-th');
      await renderPdf(browser, base, 'clics-auditor-guide-th');
      await renderPdf(browser, base, 'clics-user-auditor-guide-th');
      // Gitignored sandbox test-cohort login handout (contains credentials) — rendered only when present.
      if (await stat(join(SRC, 'test-login-guide-th.html')).then(() => true).catch(() => false)) {
        await renderPdf(browser, base, 'test-login-guide-th');
        console.log('  ✓ test-login-guide-th.pdf (gitignored)');
      }
    } finally { server.close(); }
  } finally {
    await browser.close();
  }
  console.log('\nDone → docs/manuals/*.pdf');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
