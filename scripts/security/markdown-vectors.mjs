#!/usr/bin/env node
/*
 * Regression test for the portal's AI-markdown sanitiser (markdownFragment in physician-ui/public/js/ui.js).
 *
 * WHY. DOMPurify's defaults keep plenty that fetches a remote URL or restyles the whole page. Measured in a
 * real browser with DOMPurify 3.1.6 + marked v15: style="…url()", <style> with url() / @import / @font-face,
 * <table|td background>, <input type=image src> each fetched a remote URL; <style>body{display:none}</style>
 * hid the page; <form action> + <button> survived. AI output reaches the page through that helper in three
 * places, so every vector is replayed through each of them:
 *   /ple-chat (reply bubble), /guest-chat (reply bubble), and the /ple-chat artifact panel.
 *
 * PASS = zero requests to the remote host, no stylesheet added, body still visible, no forbidden tag or
 * attribute left, and what markdown is supposed to keep (GFM task checkboxes, table align, links with their
 * current behaviour) still renders.
 *
 * NOT HERMETIC: it loads marked + DOMPurify from the same jsDelivr URLs the pages use, so it tests what a
 * physician's browser would actually run. Everything else (backend) is mocked; the remote host is aborted
 * but every attempt to reach it is counted. Exits non-zero on any failure, and says so plainly if the CDN is
 * unreachable rather than reporting a pass.
 *
 * Run: node scripts/security/markdown-vectors.mjs   (from repo root)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const API = 'http://localhost:3001';
const EVIL = 'http://evil.example';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

function startServer() {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    let file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let s = await stat(file).catch(() => null);
    if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
    if (!s) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const VECTORS = [
  `<p style="background:url(${EVIL}/style-attr.png)">styled</p>`,
  `<style>.x{background:url(${EVIL}/style-tag.png)} @import url(${EVIL}/import.css); @font-face{font-family:Z;src:url(${EVIL}/font.woff)} body{display:none}</style>`,
  `<table background="${EVIL}/table-bg.png"><tr><td background="${EVIL}/td-bg.png">cell</td></tr></table>`,
  `<input type="image" src="${EVIL}/input-image.png">`,
  `<form action="${EVIL}/post"><button>submit</button></form>`,
  `<img src="${EVIL}/img.png"><picture><source srcset="${EVIL}/pic.png"></picture><video src="${EVIL}/v.mp4" poster="${EVIL}/poster.png"></video>`,
  `<svg><image href="${EVIL}/svg.png"/></svg><iframe src="${EVIL}/frame"></iframe><object data="${EVIL}/obj"></object><embed src="${EVIL}/embed">`,
  `<link rel="stylesheet" href="${EVIL}/link.css"><meta http-equiv="refresh" content="0;url=${EVIL}/meta"><a href="https://example.com/ok" ping="${EVIL}/ping">pinged link</a>`,
].join('\n');
const KEEP = '\n\n- [x] done task\n- [ ] open task\n\n| left | centre | right |\n|:---|:---:|---:|\n| 1 | 2 | 3 |\n\n[guideline](https://example.com/guideline)\n';
const REPLY = '## Vectors\n\n' + VECTORS + KEEP;
const ARTIFACT = 'see artifact\n:::artifact{type="differential" title="DDx"}\n' + VECTORS + KEEP + '\n:::\n';
const PLE = { id: 'abc', status: 'active', title: 't', episode_number: 1, turn_count: 0, token_count: 0, messages: [] };

const fails = [];
let checks = 0;
const check = (name, cond, detail) => { checks++; if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`); };

async function run(browser, base, target) {
  const content = target === 'artifact' ? ARTIFACT : REPLY;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const remote = [];
  let cdnOk = 0;
  await ctx.route(`${API}/**`, (route) => {
    const u = new URL(route.request().url());
    const json = (b) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(b) });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/ples/abc') return json(PLE);
    if (u.pathname === '/guest/start') return json({ token: 't', max_prompts: 2 });
    if (u.pathname === '/ples/abc/message') return json({ content, message_id: 'm1', refs: [], input_tokens: 1, output_tokens: 1 });
    if (u.pathname === '/guest/message') return json({ content, refs: [], prompts_remaining: 1 });
    return json({});
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('clics_token', 'x'); localStorage.setItem('clics_user', JSON.stringify({ role: 'physician' })); });
  page.on('request', (r) => { if (r.url().startsWith(EVIL)) remote.push(r.url().slice(EVIL.length)); });
  page.on('response', (r) => { if (r.url().includes('cdn.jsdelivr.net') && r.ok()) cdnOk++; });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith(API) || u.includes('cdn.jsdelivr.net')) return r.fallback();
    return r.abort();   // remote host (counted above), fonts, anything else
  });
  await page.goto(`${base}/${target === 'guest' ? 'guest-chat' : 'ple-chat?id=abc'}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const libs = await page.evaluate(() => typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined');
  if (!libs) { fails.push(`${target}: marked / DOMPurify did not load from jsDelivr (cdn responses ok=${cdnOk}) — cannot test; this is NOT a pass`); await ctx.close(); return; }
  const sheets0 = await page.evaluate(() => document.styleSheets.length);
  await page.fill('#input', 'test'); await page.keyboard.press('Enter');
  const scope = target === 'artifact' ? '#artifactBody' : '#messages .msg-assistant:last-child';
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && /done task/.test(e.textContent); }, scope, { timeout: 10000 });
  await page.waitForTimeout(800);   // give any late fetch (font, @import, background) time to fire
  const r = await page.evaluate((s) => {
    const e = document.querySelector(s);
    const ui = '.msg-actions,.msg-refs,.msg-socratic,.ai-chip,.artifact-chip';
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      sheets: document.styleSheets.length,
      tags: [...e.querySelectorAll('style,form,object,embed,iframe,link,meta,img,picture,source,video,audio,svg,image,input:not([type=checkbox])')].filter((x) => !x.closest(ui)).map((x) => x.tagName),
      attrs: [...e.querySelectorAll('[style],[background],[src],[srcset],[poster],[action],[formaction],[ping]')].filter((x) => !x.closest(ui)).map((x) => x.tagName),
      boxes: [...e.querySelectorAll('input[type=checkbox]')].map((x) => [x.checked, x.disabled]),
      align: [...e.querySelectorAll('th')].map((x) => x.getAttribute('align')),
      link: (() => { const a = [...e.querySelectorAll('a')].find((x) => /guideline/.test(x.textContent)); return a ? [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')] : null; })(),
    };
  }, scope);
  check(`${target}: zero requests to the remote host`, remote.length === 0, JSON.stringify(remote));
  check(`${target}: no page-level style (body visible, no stylesheet added)`, r.bodyDisplay !== 'none' && r.sheets === sheets0, `${r.bodyDisplay}, sheets ${sheets0}->${r.sheets}`);
  check(`${target}: no forbidden tag`, r.tags.length === 0, JSON.stringify(r.tags));
  check(`${target}: no loading/posting attribute`, r.attrs.length === 0, JSON.stringify(r.attrs));
  check(`${target}: GFM task checkboxes kept`, JSON.stringify(r.boxes) === '[[true,true],[false,true]]', JSON.stringify(r.boxes));
  check(`${target}: table align kept`, JSON.stringify(r.align) === '["left","center","right"]', JSON.stringify(r.align));
  check(`${target}: link behaviour unchanged`, r.link && r.link[0] === 'https://example.com/guideline' && r.link[1] === null && r.link[2] === null, JSON.stringify(r.link));
  await ctx.close();
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  for (const t of ['ple', 'guest', 'artifact']) await run(browser, base, t);
} finally {
  await browser.close();
  server.close();
}
console.log(`\nMarkdown vectors: ${checks} checks across /ple-chat, /guest-chat and the artifact panel.`);
if (fails.length) { console.log('❌ ' + fails.length + ' failure(s):\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('✅ no remote fetch, no page-level style, nothing forbidden left; task lists, align and links intact.');
