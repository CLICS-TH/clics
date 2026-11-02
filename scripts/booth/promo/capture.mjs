#!/usr/bin/env node
/*
 * Captures the source frames for the booth promo (#216) into scripts/booth/promo/assets/capture/:
 * the booth flow at 1080x1920 in the fixture world of stub.mjs (stubbed booth API with the real case file, empty
 * attract loop), and the Landing page's fixture-built screenshots (physician-ui/public/img/landing). No network,
 * no prod, no AI, no staff loop file.
 *
 * Run: node scripts/booth/promo/capture.mjs   then render with scripts/booth/promo/render.sh
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join, extname, normalize, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installStub } from './stub.mjs';
import { SERVED, REPO } from './lock.mjs';

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
  const picks = [2, 3, 2];
  for (let n = 0; n < 3; n++) {
    await screen('step');
    await shot(`step${n + 1}`);
    await page.locator(`.options > [data-option]:nth-child(${picks[n]})`).tap();
    await screen('reply');
    await shot(`reply${n + 1}`);
    await page.locator(`[data-action="${n === 2 ? 'see-score' : 'next'}"]`).tap();
  }
  await screen('scoring');
  await shot('scoring');
  await screen('scored');
  await shot('result');
  await page.evaluate(() => document.querySelector('[data-board]')?.scrollIntoView({ block: 'center' }));
  await shot('result-board');
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
await writeFile(SERVED, `${JSON.stringify([...served].sort(), null, 2)}\n`);

for (const name of ['ple-chat-desktop-light', 'pis7-radar-mobile-light', 'ple-result-mobile-light']) {
  await copyFile(join(ROOT, 'img', 'landing', `${name}.webp`), join(OUT, `${name}.webp`));
  console.log(`copied ${name}.webp`);
}
await copyFile(join(ROOT, 'favicon.svg'), join(OUT, 'favicon.svg'));
for (const font of ['inter-latin-wght-normal', 'noto-sans-thai-thai-wght-normal', 'cormorant-garamond-latin-wght-normal']) {
  await copyFile(join(ROOT, 'fonts', `${font}.woff2`), join(OUT, `${font}.woff2`));
}
