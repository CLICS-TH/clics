#!/usr/bin/env node
/*
 * Captures the source frames for the booth promo (#216) into scripts/booth/promo/assets/capture/:
 * the booth flow at 1080x1920 against a stubbed booth API with the real case file, and the Landing
 * page's fixture-built screenshots (physician-ui/public/img/landing). No network, no prod, no AI.
 *
 * Run: node scripts/booth/promo/capture.mjs   then render with scripts/booth/promo/render.sh
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const KASE = JSON.parse(await readFile(fileURLToPath(new URL('../../../backend/src/booth-cases/NFCME-2026.json', import.meta.url)), 'utf8'));
const OUT = fileURLToPath(new URL('./assets/capture/', import.meta.url));
const API = 'http://localhost:3001';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// Fictional booth-mode replies: three short sentences at most, none naming the best option for a later step.
const REPLIES = [
  'ประวัติลุยน้ำท่วม ปวดน่อง และตาแดง เป็นเบาะแสสำคัญที่คุณหยิบมาใช้ได้ดี ลองคิดต่อว่าจะยืนยันการวินิจฉัยและประเมินความรุนแรงอย่างไร',
  'ผลเลือดและปัสสาวะช่วยประเมินไต ตับ และเกล็ดเลือด ซึ่งบอกความรุนแรงได้ตั้งแต่เนิ่น ๆ ขั้นต่อไปลองชั่งน้ำหนักว่าผู้ป่วยรายนี้ควรรักษาที่ไหน',
  'คุณชั่งน้ำหนักความเสี่ยงของโรคกับสภาพผู้ป่วยตอนนี้ได้ชัดเจน ลองสรุปให้ตัวเองว่าจะติดตามอาการอะไรบ้างในวันแรก ๆ',
];
const SCORE = { status: 'scored', composite: 71.6, domains: { d1: 4, d2: 4, d3: 4, d4: 3, d5: 3, d6: 3, d7: 3 } };
const at = (min) => new Date(Date.UTC(2026, 10, 3, 2, min)).toISOString();
const entries = (tags, top) => tags.map((tag, i) => ({ tag, score: top - i * 2.9, at: at(i) }));
const BOARD = { today: entries([7, 19, 42, 3, 25, 11, 30, 8, 14, 2], 79.4), event: entries([7, 19, 42, 3, 25, 11, 30, 8, 14, 2], 79.4) };

const ROUTES = {
  'GET /booth/status': () => ({ open: true, event_code: KASE.event_code, case_version: KASE.version }),
  'POST /booth/plays': () => ({ play_id: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', tag: 42, case: KASE, answer_max_chars: 500 }),
  'POST /booth/plays/:id/reply': (body) => ({ status: 'replied', reply: REPLIES[body.answers.length - 1], reply_sig: `sig-${body.answers.length}` }),
  'POST /booth/plays/:id/score': () => ({ ...SCORE, rank_today: 3, rank_event: 3, board: BOARD }),
  'GET /booth/board': () => ({ board: BOARD }),
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  let file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT + sep)) return res.writeHead(403).end();
  if (!(await stat(file).catch(() => null))?.isFile() && !extname(file)) file += '.html';
  const body = await readFile(file).catch(() => null);
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.url().startsWith(base + '/')) return route.continue();
    if (!req.url().startsWith(API + '/booth/')) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const key = `${req.method()} ${url.pathname.replace(/^\/booth\/plays\/[^/]+\/(reply|score)$/, '/booth/plays/:id/$1')}`;
    const make = ROUTES[key];
    if (!make) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    if (key.endsWith('/score')) await new Promise((r) => setTimeout(r, 2500));
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(make(JSON.parse(req.postData() ?? 'null'))) });
  });
  const page = await ctx.newPage();
  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
  };
  const shot = async (name) => { await settle(); await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log(`captured ${name}.png`); };
  const screen = (name) => page.waitForSelector(`#booth [data-screen="${name}"]`, { timeout: 10_000 });

  await page.goto(base + '/booth', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#booth[data-shell="start"]', { timeout: 10_000 });
  await shot('start');
  await page.locator('[data-action="start"]').tap();
  await screen('vignette');
  await shot('vignette');
  await page.locator('[data-action="begin"]').tap();
  const picks = ['b', 'c', 'b'];
  for (let n = 0; n < 3; n++) {
    await screen('step');
    await shot(`step${n + 1}`);
    await page.locator(`[data-option="${picks[n]}"]`).tap();
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

for (const name of ['ple-chat-desktop-light', 'pis7-radar-mobile-light', 'ple-result-mobile-light']) {
  await copyFile(join(ROOT, 'img', 'landing', `${name}.webp`), join(OUT, `${name}.webp`));
  console.log(`copied ${name}.webp`);
}
await copyFile(join(ROOT, 'favicon.svg'), join(OUT, 'favicon.svg'));
for (const font of ['inter-latin-wght-normal', 'noto-sans-thai-thai-wght-normal', 'cormorant-garamond-latin-wght-normal']) {
  await copyFile(join(ROOT, 'fonts', `${font}.woff2`), join(OUT, `${font}.woff2`));
}
