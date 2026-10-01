import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, 'pis7-ple-eval.html');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
const rows = await page.evaluate(() => {
  const MM = 3.779527;               // px per mm @96dpi
  document.body.style.width = 184 + 'mm';   // A4 minus 13mm side margins
  return [...document.querySelectorAll('.page')].map((p, i) => ({
    i: i + 1,
    mm: +(p.getBoundingClientRect().height / MM).toFixed(1),
    first: (p.querySelector('h1')?.textContent || '').slice(0, 34),
  }));
});
const LIMIT = 275;                    // A4 297mm - 12 top - 10 bottom
for (const r of rows) {
  const over = r.mm - LIMIT;
  console.log(`page ${r.i}: ${String(r.mm).padStart(6)}mm / ${LIMIT}mm  ${over > 0 ? `OVER by ${over.toFixed(1)}mm` : 'fits'}  — ${r.first}`);
}
await browser.close();
