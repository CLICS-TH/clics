#!/usr/bin/env node
// Decodes the reel's QR off its rendered frames with jsQR in headless Chromium (PR #351): every frame named must
// read exactly PORTAL_URL. The booth harness (scenarios/promo.mjs) runs it on the shipped 1080 file; run it by hand
// on the 4K render:  node scripts/booth/promo/qr-check.mjs scripts/booth/promo/renders/promo-4k.mp4
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PORTAL_URL, PROMO } from './lock.mjs';

/** Frames that show the QR: the result card at rest, and the QR scene after its one scan-line pass. */
export const QR_TIMES = [16, 17.6, 19.7, 20.5];
const JSQR = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');

/** What jsQR reads at each of `times` (seconds) of the MP4 at `file`: { t, text, size } per frame, text null if none. */
export async function decodeFrames(browser, file, times = QR_TIMES) {
  const mp4 = await readFile(file);
  const ctx = await browser.newContext();
  try {
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://reel.test') return route.abort();
      if (url.pathname === '/jsQR.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(JSQR) });
      if (url.pathname !== '/reel.mp4') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><video muted playsinline preload="auto"></video><canvas></canvas>' });
      // Byte ranges, or Chrome cannot seek and every frame read is frame 0.
      const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const from = m ? Number(m[1]) : 0;
      const to = m?.[2] ? Number(m[2]) : mp4.length - 1;
      return route.fulfill({ status: m ? 206 : 200, body: mp4.subarray(from, to + 1),
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${from}-${to}/${mp4.length}` } : {}) } });
    });
    const page = await ctx.newPage();
    await page.goto('http://reel.test/');
    await page.addScriptTag({ url: 'http://reel.test/jsQR.js' });
    return await page.evaluate(async (ts) => {
      const v = document.querySelector('video');
      const canvas = document.querySelector('canvas');
      v.src = '/reel.mp4';
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error(`video: ${v.error?.message}`)); });
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      const out = [];
      for (const t of ts) {
        await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
        c.drawImage(v, 0, 0);
        const img = c.getImageData(0, 0, canvas.width, canvas.height);
        out.push({ t, text: window.jsQR(img.data, img.width, img.height)?.data ?? null, size: `${img.width}x${img.height}` });
      }
      return out;
    }, times);
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ headless: true });
  try {
    const reads = await decodeFrames(browser, process.argv[2] ?? PROMO);
    for (const r of reads) console.log(`${r.text === PORTAL_URL ? 'ok  ' : 'FAIL'} ${r.size} t=${r.t}s -> ${r.text}`);
    process.exitCode = reads.every((r) => r.text === PORTAL_URL) ? 0 : 1;
  } finally {
    await browser.close();
  }
}
