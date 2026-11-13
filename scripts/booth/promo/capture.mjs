#!/usr/bin/env node
/*
 * Captures the source frames for the booth promo (#216) into scripts/booth/promo/assets/capture/:
 * the booth flow at 1080x1920 in the fixture world of stub.mjs (stubbed booth API with the real case file, empty
 * attract loop), and the fonts. No network, no prod, no AI, no staff loop file.
 *
 * Run: node scripts/booth/promo/capture.mjs   then render with scripts/booth/promo/render.sh
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join, extname, normalize, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installStub, STEPS } from './stub.mjs';
import { SERVED, REPO, PORTAL_URL } from './lock.mjs';

const ROOT = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const OUT = fileURLToPath(new URL('./assets/capture/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };

// Every file the page loads, so promo.lock.json can digest exactly what the frames were rendered from.
const served = new Set();
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  let file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT + sep)) return res.writeHead(403).end();
  if (!(await stat(file).catch(() => null))?.isFile() && !extname(file)) file += '.html';
  const body = await readFile(file).catch(() => null);
  if (!body) return res.writeHead(404).end();
  served.add(relative(REPO, file));
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installStub(ctx, base, { scoreDelayMs: 2500 });
  const page = await ctx.newPage();
  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
  };
  const shot = async (name) => { await settle(); await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log(`captured ${name}.png`); };
  const screen = (name) => page.waitForSelector(`#booth [data-screen="${name}"]`, { timeout: 10_000 });

  await page.goto(base + '/booth', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#booth[data-shell="start"]', { timeout: 10_000 });
  await settle();
  await page.locator('[data-action="start"]').tap();
  await screen('teaser');
  await settle();
  await page.locator('[data-action="start-case"]').tap();
  await screen('vignette');
  await shot('vignette');
  await page.locator('[data-action="begin"]').tap();
  // The option each step taps, by position; stub.mjs REPLIES answers these picks.
  const picks = [2, 3, 2, 2, 2];
  for (let n = 0; n < STEPS; n++) {
    await screen('step');
    await shot(`step${n + 1}`);
    const option = `.options > [data-option]:nth-child(${picks[n]})`;
    await page.locator(option).tap();
    await page.waitForSelector(`${option}[aria-pressed="true"]`, { timeout: 10_000 });
    await settle();
    await page.locator('[data-action="send"]').tap();
    await screen('reply');
    await shot(`reply${n + 1}`);
    await page.locator(`[data-action="${n === STEPS - 1 ? 'see-score' : 'next'}"]`).tap();
  }
  await screen('scoring');
  await shot('scoring');
  await screen('scored');
  // The card's own QR would open this capture server's 127.0.0.1 address. Redrawn by the page's own encoder, the
  // way booth-play.js draws it (4-module quiet zone), but at EC level M and holding the Portal, so a visitor who
  // scans the reel lands on PORTAL_URL (qr-check.mjs proves it decodes off the rendered frames).
  await page.locator('[data-keep-qr] svg').evaluate((svg, url) => {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    svg.setAttribute('viewBox', `0 0 ${n + 8} ${n + 8}`);
    svg.innerHTML = `<rect width="${n + 8}" height="${n + 8}" fill="#fff"/><path fill="#000" d="${d}"/>`;
  }, PORTAL_URL);
  // The look switch is screen chrome over the card's top corner; its shadow would band the reel's card window.
  await page.locator('[data-look-control]').evaluate((e) => { e.style.visibility = 'hidden'; });
  await shot('result');
  await page.evaluate(() => document.querySelector('[data-board]')?.scrollIntoView({ block: 'center' }));
  await shot('result-board');
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
await writeFile(SERVED, `${JSON.stringify([...served].sort(), null, 2)}\n`);

for (const font of ['inter-latin-wght-normal', 'noto-sans-thai-thai-wght-normal', 'cormorant-garamond-latin-wght-normal']) {
  await copyFile(join(ROOT, 'fonts', `${font}.woff2`), join(OUT, `${font}.woff2`));
}
