#!/usr/bin/env node
/*
 * Render scripts/report/pis7-ple-eval.html → pis7-ple-evaluation.pdf (A4, 5 pages).
 * Same recipe as render-eval.mjs: wait for the Google web fonts before capturing,
 * else the Thai headings render as tofu. Run from repo root:
 *   node scripts/report/render-pis7-eval.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, 'pis7-ple-eval.html');
const OUT  = join(HERE, '..', '..', 'pis7-ple-evaluation.pdf');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(HTML).href, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', bottom: '10mm', left: '13mm', right: '13mm' },
  });
  console.log('✓ PDF → ' + OUT);
} finally {
  await browser.close();
}
