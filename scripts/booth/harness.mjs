#!/usr/bin/env node
/*
 * Scenarios live in scripts/booth/scenarios/*.mjs, one file per ticket, found by readdir:
 *   export default [{ name, async run(h) { ... } }]
 * so #212 (board.mjs) and #213 (shell.mjs) add a file and never edit this one. A scenario gets every helper
 * through `h` and imports nothing from this file (it is the entry script; importing it would run it). The stub's
 * routes are keyed "METHOD /path" and a scenario merges its own over the defaults.
 *
 * Run: npm run test:booth   (repo root). Exits non-zero on any FAIL. Set BOOTH_SHOTS=<dir> to save screenshots, and
 * BOOTH_ONLY=<text> to run only the scenarios whose name contains it.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const CASES = fileURLToPath(new URL('../../backend/src/booth-cases', import.meta.url));
const SCENARIOS = new URL('./scenarios/', import.meta.url);

// booth-copy.js has no imports, so a data: URL loads it as the module it is, without a package.json type.
const COPY_SOURCE = await readFile(join(ROOT, 'js', 'booth-copy.js'), 'utf8');
const { DEMO_LABEL, DOMAINS, COPY } = await import(`data:text/javascript,${encodeURIComponent(COPY_SOURCE)}`);
const TREE = JSON.parse(await readFile(fileURLToPath(new URL('../../backend/tests/fixtures/booth-case-tree.json', import.meta.url)), 'utf8'));
/** The `case` a started play carries: the vignette only; each step's text arrives in a Next. */
const KASE = { vignette: TREE.vignette };

const BANNED = [/on[-\s]?premise/i, /validated/i, /ติดตั้งภายในองค์กร/];
const withoutDemoLabel = (text) => text.split(DEMO_LABEL.th).join('').split(DEMO_LABEL.en).join('');

const FLOOR = { textPx: 28, optionLabelPx: 32, tapPx: 80, contrast: 4.5, thaiLeading: 1.4 };
const PLAY_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const API = 'http://localhost:3001';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'cache-control': 'no-store' };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.mp4': 'video/mp4' };
const WAIT_MS = 10_000;
const SETTLE_MS = 400;
const SHOTS = process.env.BOOTH_SHOTS || null;
const ONLY = process.env.BOOTH_ONLY || '';

const fails = [];
let passes = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (ok) passes++; else fails.push(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      let file = normalize(join(ROOT, p));
      if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (!s?.isFile() && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s?.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const TIER_LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const bankFor = (tree, path) => (path.length === 0 ? tree.banks.step1 : tree.banks[`step${path.length + 1}`][path]);

/** The tier the stub sorts a typed answer into; best, so a typed answer steers away from the weaker branch. */
const TYPED_TIER = 'B';

/** The tier path the visitor's answers walked: a tapped answer takes its option's tier, a typed one the tier the
 *  stub sorted it into (the kiosk never sees it). */
function pathOf(tree, answers) {
  let path = '';
  for (const a of answers) {
    const tier = 'choice' in a ? bankFor(tree, path).options.find((o) => o.id === a.choice)?.tier : null;
    path += 'choice' in a ? TIER_LETTER[tier] ?? 'W' : TYPED_TIER;
  }
  return path;
}

/**
 * The Next the stub issues for `path`, built the way the server does but deterministic: the last variant, and
 * the bank's default trio rotated by step so a tier never keeps one position. Text is the bank's, copied.
 */
function nextFor(tree, path, bridge = '') {
  const bank = bankFor(tree, path);
  const variant = bank.variants[bank.variants.length - 1];
  const shift = path.length % 3;
  const ids = [...bank.default_trio.slice(shift), ...bank.default_trio.slice(0, shift)];
  const options = ids.map((id) => { const o = bank.options.find((x) => x.id === id); return { id, label: o.label, line: o.line }; });
  return { ask: { variant: variant.id, bridge, options: ids }, question: variant.question, options };
}

const BRIDGE = (n) => (n === 1 ? 'คุณนึกถึงปอดอักเสบได้ตรงกับอาการที่เห็น' : 'ลองคิดต่อถึงการดูแลผู้ป่วยรายนี้');
// 120 characters, the contract's ceiling for a bridge, and one sentence by the backend's rule: one Thai phrase,
// with no space between Thai letters (booth.js oneSentence).
const LONG_BRIDGE = 'คุณเชื่อมโยงไข้ไอมีเสมหะกับเสียงกรอบแกรบที่ปอดขวาล่างได้ดีจึงน่าคิดต่อว่าผลตรวจใดช่วยยืนยันและบอกความรุนแรงของโรคได้ชัดๆ';

/** The tallest Next a bank can issue: its longest variant and its longest option of each tier. */
function bankWorstNext(bank, bridge = LONG_BRIDGE) {
  const size = (b) => b.th.length + b.en.length;
  const variant = [...bank.variants].sort((a, b) => size(b.question) - size(a.question))[0];
  const options = ['best', 'reasonable', 'weaker'].map((tier) => bank.options.filter((o) => o.tier === tier)
    .sort((a, b) => size(b.label) + size(b.line) - size(a.label) - size(a.line))[0]);
  return { ask: { variant: variant.id, bridge, options: options.map((o) => o.id) }, question: variant.question,
    options: options.map(({ id, label, line }) => ({ id, label, line })) };
}

/** Every bank of the fixture and of every case file in backend/src/booth-cases/<EVENT>/, as its worst Next, with
 *  identical Nexts kept once. Read per run, so a case file that lands on master is checked without a harness edit. */
async function caseBankNexts(bridge = LONG_BRIDGE) {
  const files = (await readdir(CASES, { recursive: true })).filter((f) => /^[^/]+\/[^/]+\.json$/.test(f)).sort();
  const trees = [['fixture', TREE], ...await Promise.all(files.map(async (f) => [f, JSON.parse(await readFile(join(CASES, f), 'utf8'))]))];
  const seen = new Set();
  return trees.flatMap(([file, tree]) => Object.entries({ step1: tree.banks.step1,
    ...Object.fromEntries(Object.entries(tree.banks.step2).map(([p, b]) => [`step2.${p}`, b])),
    ...Object.fromEntries(Object.entries(tree.banks.step3).map(([p, b]) => [`step3.${p}`, b])) })
    .map(([at, bank]) => ({ name: `${file} ${at}`, next: bankWorstNext(bank, bridge) })))
    .filter(({ next }) => { const key = JSON.stringify(next); return !seen.has(key) && seen.add(key); });
}

/** A Next of the longest fixture texts (question and the three longest options, any bank) for the fit checks. */
function longestNext(tree, bridge = LONG_BRIDGE) {
  const banks = [tree.banks.step1, ...Object.values(tree.banks.step2), ...Object.values(tree.banks.step3)];
  const thLen = (b) => b.th.length + b.en.length;
  const question = banks.flatMap((b) => b.variants).sort((a, b) => thLen(b.question) - thLen(a.question))[0].question;
  const seen = new Set();
  const options = banks.flatMap((b) => b.options).sort((a, b) => thLen(b.label) + thLen(b.line) - thLen(a.label) - thLen(a.line))
    .filter((o) => !seen.has(o.id) && seen.add(o.id)).slice(0, 3).map(({ id, label, line }) => ({ id, label, line }));
  return { ask: { variant: 'v1', bridge, options: options.map((o) => o.id) }, question, options };
}

const REPLY = (n) => `AI reply ${n}: <b>not markup</b>\nsecond line\nคำตอบนี้ครอบคลุมประเด็นสำคัญแล้ว ลองพิจารณาผลน้ำตาลสะสมร่วมกับประวัติครอบครัว และนัดติดตามอาการภายใน 3 เดือน`;
const SIG = (n) => `sig-${n}`;
const START = { play_id: PLAY_ID, tag: 42, answer_max_chars: 500, case: KASE, next: nextFor(TREE, ''), sig: SIG(0) };
/** What a draw answers: the case id and its teaser, nothing else of the case. */
const drawOf = (tree) => ({ case_id: tree.case_id, teaser: tree.teaser });
const DRAW = drawOf(TREE);
/** The default reply to answer n: reply n, its sig, and (after answers 1 and 2) the Next for the path walked. */
function replyBody(answers, { reply = REPLY(answers.length), bridge = BRIDGE(answers.length) } = {}) {
  const n = answers.length;
  return { status: 'replied', reply, reply_sig: SIG(n), ...(n < 3 ? { next: nextFor(TREE, pathOf(TREE, answers), bridge) } : {}) };
}
const SCORED = { status: 'scored', composite: 72.4, domains: { d1: 4, d2: 3, d3: 4, d4: 2, d5: 3, d6: 5, d7: 1 } };

/**
 * A fresh stub per kiosk. Default routes:
 *   'GET /booth/status'            { open: true, event_code }
 *   'POST /booth/draw'             DRAW: { case_id, teaser } of the fixture case
 *   'POST /booth/plays'            START: { play_id, tag: 42, answer_max_chars: 500, case: { vignette }, next, sig };
 *                                  400 bad_request unless the body names a case_id
 *   'POST /booth/plays/:id/reply'  replyBody(answers): reply n, SIG(n), next for the tier path walked (n < 3)
 * The case is backend/tests/fixtures/booth-case-tree.json.
 *   'GET /booth/board'             { board: { today: [], event: [] } }
 *   'POST /booth/plays/:id/score'  SCORED
 * opts.routes merges over these: key -> (call, calls) => ({ status, body }) | 'abort'. Unknown keys answer 404.
 * stub.hold(key) returns release(): matching requests wait until released. stub.calls records every request as
 * { key, path, body, headers }; stub.of(key) filters it.
 */
function makeStub({ routes = {} } = {}) {
  const calls = [];
  const holds = new Map();
  const table = {
    'GET /booth/status': () => ({ status: 200, body: { open: true, event_code: TREE.event_code } }),
    'POST /booth/draw': () => ({ status: 200, body: DRAW }),
    'POST /booth/plays': (call) => (typeof call.body?.case_id === 'string'
      ? { status: 201, body: START } : { status: 400, body: { error: 'That answer could not be read.', reason: 'bad_request' } }),
    'POST /booth/plays/:id/reply': (call) => ({ status: 200, body: replyBody(call.body?.answers ?? []) }),
    'GET /booth/board': () => ({ status: 200, body: { board: { today: [], event: [] } } }),
    'POST /booth/plays/:id/score': () => ({ status: 200, body: SCORED }),
    ...routes,
  };
  return {
    calls,
    of: (key) => calls.filter((c) => c.key === key),
    hold(key) {
      let release;
      holds.set(key, new Promise((r) => { release = r; }));
      return () => release();
    },
    async handle(route) {
      const req = route.request();
      try {
        if (req.method() === 'OPTIONS') return await route.fulfill({ status: 204, headers: CORS });
        const path = new URL(req.url()).pathname;
        const key = `${req.method()} ${path.replace(/^\/booth\/plays\/[^/]+\/(reply|score)$/, '/booth/plays/:id/$1')}`;
        let body = null;
        if (req.method() === 'POST') { try { body = JSON.parse(req.postData() ?? 'null'); } catch { body = '<not json>'; } }
        const call = { key, path, body, headers: await req.allHeaders() };
        calls.push(call);
        if (holds.has(key)) await holds.get(key);
        const out = table[key] ? await table[key](call, calls) : { status: 404, body: { error: 'Not found', reason: 'not_found' } };
        if (out === 'abort') return await route.abort('failed');
        return await route.fulfill({ status: out.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(out.body) });
      } catch {
        // the context closed while this request was held
      }
    },
  };
}

/** A fixture loop file with a content ETag, answering a matching If-None-Match with 304 the way Vercel does. */
async function fulfillFile(route, file) {
  const body = await readFile(file);
  const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
  const headers = { 'cache-control': 'no-store', etag };
  if (route.request().headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers });
  return route.fulfill({ body, contentType: MIME[extname(file)] || 'application/octet-stream', headers });
}

let browser;
let base;
const open = new Set();

/**
 * A new browser context on /booth with the stub routed in.
 * pointer 'coarse': isMobile + hasTouch, and the run asserts matchMedia('(pointer: coarse)') really matches.
 * pointer 'fine':   a plain desktop context (the mini-PC reporting a mouse); taps become clicks.
 * close() fails the run if any foreign request was made or any page error, CSP refusal or storage write happened.
 * files: { '/path': absolute file } served instead of disk for same-origin requests (fixture loop files), with an
 *   ETag; it is read per request, so a scenario that reassigns an entry replaces the file under the same name.
 * k.offline(on): the context goes offline and every request (page origin and booth API) aborts.
 */
async function kiosk({ width = 1080, height = 1920, pointer = 'coarse', stub = makeStub(), label = `${width}x${height} ${pointer}`, files = {} } = {}) {
  const coarse = pointer === 'coarse';
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ...(coarse ? { isMobile: true, hasTouch: true } : {}) });
  const foreign = [];
  const errors = [];
  let offline = false;
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (offline) return route.abort('internetdisconnected');
    if (url.startsWith(base + '/')) {
      const file = files[new URL(url).pathname];
      if (file) return fulfillFile(route, file);
      return route.continue();
    }
    if (url.startsWith(API + '/booth/')) return stub.handle(route);
    foreign.push(url);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(`CSP: ${m.text()}`); });
  await page.goto(base + '/booth', { waitUntil: 'domcontentloaded' });
  const media = coarse ? '(pointer: coarse)' : '(pointer: fine)';
  check(await page.evaluate((q) => matchMedia(q).matches, media), `${label}: matchMedia('${media}') matches`);

  const k = {
    page, ctx, stub, foreign, errors,
    async offline(on) {
      offline = on;
      await ctx.setOffline(on);
    },
    async tap(selector) {
      const loc = page.locator(selector);
      if (coarse) await loc.tap({ timeout: WAIT_MS }); else await loc.click({ timeout: WAIT_MS });
    },
    /** Two taps 40 ms apart at the centre of `selector`, the way a hurried finger lands. */
    async doubleTap(selector) {
      const b = await page.locator(selector).boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      if (coarse) { await page.touchscreen.tap(x, y); await sleep(40); await page.touchscreen.tap(x, y); }
      else { await page.mouse.click(x, y); await sleep(40); await page.mouse.click(x, y); }
    },
    /** Wait for the play to show `name` (root.dataset.screen), its fonts and its entrance animation. */
    async screen(name) {
      await page.waitForSelector(`#booth [data-screen="${name}"]`, { timeout: WAIT_MS });
      await page.evaluate(() => document.fonts.ready);
      await sleep(SETTLE_MS);
      await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: WAIT_MS });
    },
    screenNow: () => page.evaluate(() => document.querySelector('#booth [data-screen]')?.dataset.screen ?? null),
    /** Tap option n (1-3) of the step and wait until it shows chosen. */
    async choose(n) {
      const option = `.options > [data-option]:nth-child(${n})`;
      await k.tap(option);
      await page.waitForSelector(`${option}[aria-pressed="true"]`, { timeout: WAIT_MS });
    },
    /** Answer the step with option n (1-3) the way a visitor does: choose it, then Send. */
    async answer(n) {
      await k.choose(n);
      await k.tap('[data-action="send"]');
    },
    /** From the Tap-to-try bar to the vignette: tap it, take the dealt case's teaser, tap "Start this case". */
    async toVignette() {
      await k.tap('[data-action="start"]');
      await k.screen('teaser');
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
    },
    /** Wait for the shell's own state (#booth[data-shell]). */
    async shell(name, timeout = WAIT_MS) {
      await page.waitForSelector(`#booth[data-shell="${name}"]`, { timeout });
      await page.evaluate(() => document.fonts.ready);
      await sleep(SETTLE_MS);
    },
    async close() {
      if (!open.has(k)) return;
      open.delete(k);
      const stored = await page.evaluate(async () => ({
        local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length,
      })).catch(() => null);
      check(!stored || (stored.local === 0 && stored.session === 0 && stored.idb === 0),
        `${label}: nothing stored (localStorage ${stored?.local}, sessionStorage ${stored?.session}, IndexedDB ${stored?.idb})`);
      check(stub.calls.every((c) => !c.headers.cookie), `${label}: no request carried a cookie`);
      check(foreign.length === 0, `${label}: no request left the page and the booth API${foreign.length ? ` (${foreign.slice(0, 3).join(', ')})` : ''}`);
      check(errors.length === 0, `${label}: no page error or CSP refusal${errors.length ? ` (${errors.slice(0, 2).join(' | ')})` : ''}`);
      await ctx.close();
    },
  };
  open.add(k);
  return k;
}

/**
 * A phone on a Portal page (#251's result page): `path` may carry a fragment. Every request is recorded in k.requests.
 * close() fails the run on any page error or CSP refusal, any request off the page's origin, and any request
 * that is not a plain file load (fetch, XHR, beacon, socket).
 */
async function phone(path, { width = 375, height = 812 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const requests = [];
  const errors = [];
  await ctx.route('**/*', (route) => {
    const req = route.request();
    requests.push({ url: req.url(), type: req.resourceType(), method: req.method() });
    return req.url().startsWith(base + '/') ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(base + path, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const label = `phone ${width}x${height}`;
  const k = {
    page, requests, errors,
    async close() {
      if (!open.has(k)) return;
      open.delete(k);
      const off = requests.filter((r) => !r.url.startsWith(base + '/'));
      const calls = requests.filter((r) => r.method !== 'GET' || !['document', 'stylesheet', 'script', 'font', 'image'].includes(r.type));
      check(off.length === 0, `${label}: no request left the Portal${off.length ? ` (${off.slice(0, 3).map((r) => r.url).join(', ')})` : ''}`);
      check(calls.length === 0, `${label}: file loads only, no fetch, XHR or beacon${calls.length ? ` (${calls.slice(0, 3).map((r) => `${r.type} ${r.url}`).join(', ')})` : ''}`);
      check(errors.length === 0, `${label}: no page error or CSP refusal${errors.length ? ` (${errors.slice(0, 2).join(' | ')})` : ''}`);
      await ctx.close();
    },
  };
  open.add(k);
  return k;
}

function measure({ floor, banned, demo, demoLabel }) {
  const scale = innerWidth / 1080;
  const out = [];
  const say = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 50);
  const cvs = document.createElement('canvas'); cvs.width = 1; cvs.height = 1;
  const g2d = cvs.getContext('2d', { willReadFrequently: true });
  const memo = new Map();
  const parseRgb = (s) => {
    if (!s) return null;
    if (memo.has(s)) return memo.get(s);
    let out = null;
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
      out = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    } else if (s === 'transparent') {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      const am = /\/\s*([\d.]+)(%?)\s*\)$/.exec(s);
      const a = am ? parseFloat(am[1]) / (am[2] ? 100 : 1) : 1;
      const opaque = am ? s.replace(/\s*\/\s*[\d.]+%?\s*\)$/, ')') : s;
      const SENTINEL = '#010203';
      g2d.fillStyle = SENTINEL; g2d.fillStyle = opaque;
      if (String(g2d.fillStyle).toLowerCase() !== SENTINEL) {
        g2d.clearRect(0, 0, 1, 1); g2d.fillRect(0, 0, 1, 1);
        const d = g2d.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a };
      }
    }
    memo.set(s, out);
    return out;
  };
  const over = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b, a: 1,
  });
  const paintedBg = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const root = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    if (root && root.a === 1) base = root;
    let out = stack.length && stack[stack.length - 1].a === 1 ? stack.pop() : base;
    while (stack.length) out = over(stack.pop(), out);
    return out;
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  const px = (v) => parseFloat(v);

  const texts = [...document.body.querySelectorAll('*')].filter((e) => shown(e)
    && ([...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) || e.matches('textarea, input')));
  for (const e of texts) {
    const cs = getComputedStyle(e);
    const size = px(cs.fontSize);
    if (size < floor.textPx * scale - 0.01) out.push(`text ${size}px < ${floor.textPx * scale}px: "${say(e)}"`);
    const fg = parseRgb(cs.color);
    const bg = paintedBg(e);
    const cr = ratio(over(fg, bg), bg);
    if (cr < floor.contrast) out.push(`contrast ${cr.toFixed(2)}:1 < ${floor.contrast}:1 (${cs.color} on rgb(${bg.r}, ${bg.g}, ${bg.b})): "${say(e)}"`);
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('') + (e.value || '');
    if (/[฀-๿]/.test(own)) {
      const lh = cs.lineHeight === 'normal' ? 0 : px(cs.lineHeight) / size;
      if (lh < floor.thaiLeading) out.push(`Thai line-height ${cs.lineHeight} (${lh.toFixed(2)}) < ${floor.thaiLeading}: "${say(e)}"`);
    }
    const r = e.getBoundingClientRect();
    if (r.left < -1 || r.right > innerWidth + 1) out.push(`text outside the screen (x ${Math.round(r.left)}..${Math.round(r.right)}): "${say(e)}"`);
  }
  const labels = [...document.querySelectorAll('.opt-label .bi-th, .opt-label .bi-en')].filter(shown);
  for (const e of labels) {
    const size = px(getComputedStyle(e).fontSize);
    if (size < floor.optionLabelPx * scale - 0.01) out.push(`option label ${size}px < ${floor.optionLabelPx * scale}px: "${say(e)}"`);
  }
  const taps = [...document.querySelectorAll('button, [role="button"], textarea, input, a[href]')].filter(shown);
  for (const e of taps) {
    const r = e.getBoundingClientRect();
    if (r.width < floor.tapPx * scale - 0.01 || r.height < floor.tapPx * scale - 0.01) out.push(`tap target ${Math.round(r.width)}x${Math.round(r.height)} < ${floor.tapPx * scale}px: "${say(e)}"`);
  }
  const pen = document.createElement('canvas').getContext('2d');
  for (const th of [...document.body.querySelectorAll('[lang="th"]:not(textarea)')].filter(shown)) {
    if (!/[฀-๿]/.test(th.textContent)) continue;
    const chars = [];
    const walk = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) for (let i = 0; i < n.data.length; i++) chars.push({ n, i });
    const line = chars.map(({ n, i }) => n.data[i]).join('');
    const lh = px(getComputedStyle(th).lineHeight);
    const range = document.createRange();
    let prev = null;
    chars.forEach(({ n, i }, k) => {
      if (/\s|\p{M}/u.test(line[k])) return;
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const top = range.getBoundingClientRect().top;
      if (prev && top > prev.top + lh / 2 && !/\s/.test(line.slice(prev.k + 1, k))) {
        const a = line.slice(0, k).search(/\S*$/);
        const end = line.slice(k).search(/\s/);
        const b = end === -1 ? line.length : k + end;
        const cs = getComputedStyle(n.parentElement);
        pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        if (pen.measureText(line.slice(a, b)).width < th.clientWidth - 1) out.push(`Thai line broken inside a phrase: "${line.slice(a, k)}|${line.slice(k, b)}"`);
      }
      prev = { top, k };
    });
  }

  const doc = document.scrollingElement;
  if (doc.scrollWidth > innerWidth + 1) out.push(`page is ${doc.scrollWidth}px wide on a ${innerWidth}px screen`);
  if (window.scrollY !== 0) out.push(`page scrolled to y ${window.scrollY}`);

  const rest = document.body.innerText.split(demoLabel.th).join('').split(demoLabel.en).join('');
  for (const [src, flags] of banned) {
    const m = new RegExp(src, flags).exec(rest);
    if (m) out.push(`banned copy "${m[0]}" on screen`);
  }
  const label = [...document.querySelectorAll('[data-demo-label]')].find((e) => shown(e)
    && e.innerText.includes(demoLabel.th) && e.innerText.includes(demoLabel.en));
  const numeric = /\d/.test(rest);
  if (demo === true || (demo === 'auto' && numeric)) {
    if (!label) out.push(`a number is on screen but the demo label is not`);
    else {
      const r = label.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight + 1) out.push(`the demo label is off screen (y ${Math.round(r.top)}..${Math.round(r.bottom)})`);
    }
  }
  return { out, scale, texts: texts.length, labels: labels.length, taps: taps.length, numeric, demoShown: !!label };
}

/**
 * The checks every booth screen must pass, in one page.evaluate: text >= 28px x scale with AA contrast against
 * its composited background and Thai leading >= 1.4, option labels >= 32px x scale, tap targets >= 80px x scale,
 * nothing outside the screen, no page scroll, no banned copy, and the demo label on screen whenever a digit is.
 * @param {{ demo?: true | 'auto' }} [opts] true: the label is required even with no digit on screen
 */
async function screenCheck(page, label, opts = {}) {
  const r = await page.evaluate(measure, { floor: FLOOR, banned: BANNED.map((b) => [b.source, b.flags]), demo: opts.demo ?? 'auto', demoLabel: DEMO_LABEL });
  const f = (n) => Math.round(n * r.scale);
  check(r.texts > 0, `${label}: ${r.texts} texts, ${r.labels} option labels, ${r.taps} tap targets measured`);
  r.out.slice(0, 12).forEach((m) => check(false, `${label}: ${m}`));
  if (r.out.length > 12) check(false, `${label}: ${r.out.length - 12} more failures`);
  if (!r.out.length) {
    check(true, `${label}: text >= ${f(FLOOR.textPx)}px, option labels >= ${f(FLOOR.optionLabelPx)}px, taps >= ${f(FLOOR.tapPx)}px, `
      + `AA contrast, Thai leading, no overflow, copy rule${r.demoShown ? ', demo label on screen' : ''}`);
  }
  return r;
}

async function scanSources() {
  const groups = [
    ['physician-ui/public/booth*.html', ROOT, (f) => /^booth.*\.html$/.test(f)],
    ['physician-ui/public/css/booth*.css', join(ROOT, 'css'), (f) => /^booth.*\.css$/.test(f)],
    ['physician-ui/public/js/booth-*.js', join(ROOT, 'js'), (f) => /^booth-.*\.js$/.test(f)],
    ['backend/src/booth-cases/*/*.json', CASES, (f) => /^[^/]+\/[^/]+\.json$/.test(f)],
  ];
  for (const [glob, dir, match] of groups) {
    const files = (await readdir(dir, { recursive: true })).filter(match).sort();
    const hits = [];
    for (const f of files) {
      const text = withoutDemoLabel(await readFile(join(dir, f), 'utf8'));
      for (const re of BANNED) { const m = re.exec(text); if (m) hits.push(`${f}: "${m[0]}"`); }
    }
    check(files.length > 0 && hits.length === 0, `copy rule in ${glob} (${files.length} files: ${files.join(', ')})${hits.length ? `: ${hits.join('; ')}` : ''}`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  console.log(`     screenshot ${path}`);
}

const server = await startServer();
base = `http://127.0.0.1:${server.address().port}`;
browser = await chromium.launch();
const h = { kiosk, phone, makeStub, screenCheck, check, shot, sleep, same: isDeepStrictEqual, FLOOR, DEMO_LABEL, DOMAINS, COPY, KASE, TREE, PLAY_ID, TYPED_TIER, REPLY, SIG, SCORED,
  START, DRAW, drawOf, BRIDGE, LONG_BRIDGE, bankFor, pathOf, nextFor, longestNext, caseBankNexts, replyBody };

try {
  await scanSources();
  const files = (await readdir(SCENARIOS)).filter((f) => f.endsWith('.mjs')).sort();
  let count = 0;
  for (const file of files) {
    for (const sc of (await import(new URL(file, SCENARIOS))).default) {
      if (!sc.name.includes(ONLY)) continue;
      count++;
      console.log(`\n== ${file}: ${sc.name}`);
      try { await sc.run(h); } catch (e) { check(false, `${sc.name} threw: ${String(e.message).split('\n')[0]}`); }
      for (const k of [...open]) await k.close().catch(() => {});
    }
  }
  check(count > 0, `${count} scenarios found in scripts/booth/scenarios/ (${files.join(', ')})`);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${fails.length ? 'FAIL' : 'PASS'} booth harness: ${passes} checks passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
