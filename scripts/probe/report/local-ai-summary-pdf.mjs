#!/usr/bin/env node
/*
 * Render docs/reports/local-ai-test-summary.html to A4 PDF.
 * Waits for document.fonts.ready before printing — without it Thai vowels and tone marks render as
 * tofu or detach from their consonants, which is invisible in the HTML and fatal in the PDF.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { access } from 'node:fs/promises';

const ROOT = process.cwd();
const html = path.join(ROOT, 'docs/reports/local-ai-test-summary.html');
const pdf = path.join(ROOT, 'docs/reports/local-ai-test-summary.pdf');
await access(html);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
// Prove the Thai face actually resolved; a silent fallback is the failure mode this guards.
const fontOk = await page.evaluate(() => {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:80px;';
  probe.textContent = 'ทดสอบภาษาไทย';
  document.body.appendChild(probe);
  probe.style.fontFamily = 'monospace'; const w0 = probe.offsetWidth;
  probe.style.fontFamily = '"TH Sarabun New", monospace'; const w1 = probe.offsetWidth;
  probe.remove();
  return { differs: w0 !== w1, w0, w1 };
});
if (!fontOk.differs) {
  await browser.close();
  console.error(`\n  FAIL: "TH Sarabun New" did not resolve — Thai would render in a fallback face.`);
  console.error(`  monospace width ${fontOk.w0}px === TH Sarabun width ${fontOk.w1}px\n`);
  process.exit(1);
}
await page.pdf({ path: pdf, format: 'A4', printBackground: true,
  margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' } });
await browser.close();
console.log(`  Thai font resolved (${fontOk.w0}px → ${fontOk.w1}px)`);
console.log('  wrote', path.relative(ROOT, pdf));
