#!/usr/bin/env node
/*
 * Lost-connection settle smoke for /ple-chat (physician-ui/public/js/ple-chat.js, client_turn_id).
 *
 * Drives the REAL page in Chromium against a faked backend (every request to the API origin is answered
 * here; everything else is aborted), so it needs no backend, no secrets and no network. It checks that a
 * chat turn whose connection drops is never blindly re-sent: the page reads the episode back first, shows
 * the stored reply if it arrived, offers Retry with the SAME key only if it did not, survives a reload
 * (sessionStorage), and that End is held while a turn is in flight. Exits non-zero on any failure.
 *
 * Run: node scripts/chat/turn-settle-smoke.mjs   (from repo root; ~30 s, the long waits use a fake clock)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function startServer() {
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(ROOT, p));
    let s = await stat(file).catch(() => null);
    if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
    if (!s) { res.writeHead(404).end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fails = [];
const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails.push(msg); };
const json = (route, status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

async function scenario(browser, base, name, { onPost, onEnd, keyed = false, useClock = false, ceiling = null, getDelayMs = 0 }, drive) {
  console.log('\n== ' + name);
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('clics_token', 'x'); } catch {} });
  const store = { messages: [], posts: [], gets: 0 };
  let n = 0;
  // keyed = the backend has the client_turn_id column: physician rows carry it (null when unkeyed).
  const addTurn = (text, reply, key) => {
    n++;
    store.messages.push({ id: 'p' + n, role: 'physician', content: text, created_at: new Date().toISOString(), ...(keyed ? { client_turn_id: key ?? null } : {}) });
    if (reply) store.messages.push({ id: 'a' + n, role: 'assistant', content: reply, refs: [], socratic_question: null, token_count: 10, created_at: new Date().toISOString() });
  };
  const addReply = (reply) => store.messages.push({ id: 'a' + (++n), role: 'assistant', content: reply, refs: [], socratic_question: null, token_count: 10, created_at: new Date().toISOString() });
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith(base)) return route.continue();
    if (!url.startsWith('http://localhost:3001')) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(url).pathname;
    if (path === '/ples/ple1' && req.method() === 'GET') {
      store.gets++;
      if (getDelayMs && store.gets === 1) await new Promise((r) => setTimeout(r, getDelayMs));
      return json(route, 200, { id: 'ple1', status: 'active', title: 't', turn_count: 0, token_count: 50, messages: store.messages, transcript: null,
        ...(ceiling ? { turn_ceiling_ms: ceiling } : {}) });
    }
    if (path === '/ples/ple1/message' && req.method() === 'POST') {
      const body = JSON.parse(req.postData());
      store.posts.push(body);
      return onPost({ route, body, store, addTurn, addReply });
    }
    if (path === '/ples/ple1/end' && onEnd) return onEnd({ route });
    return json(route, 200, {});
  });
  if (useClock) await page.clock.install();
  await page.goto(base + '/ple-chat?id=ple1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#input');
  await page.waitForTimeout(300);
  // A step that times out is a failed scenario, not a crashed run: record it and go on to the next one.
  try { await drive({ page, store, addTurn, addReply }); }
  catch (e) { check(false, `${name}: ${String(e.message).split('\n')[0]}`); }
  await ctx.close();
}

const text = 'what is the differential for chest pain';
const count = (page, sel) => page.locator('#messages ' + sel).count();
const bodyHas = (page, t, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout });
const sendText = async (page, t) => { await page.fill('#input', t); await page.press('#input', 'Enter'); };
const pump = async (page, ms) => { for (let i = 0; i < ms / 3000; i++) { await page.clock.runFor(3000); await page.waitForTimeout(25); } };

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

await scenario(browser, base, 'A: dropped connection, turn stored late (text-match fallback: no key column) -> shown, never re-sent', {
  onPost: ({ route, store, addTurn, addReply }) => {
    setTimeout(() => addTurn(text, null), 1000);
    setTimeout(() => addReply('STORED REPLY'), 4000);
    return route.abort('failed');
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system', { timeout: 5000 });
  const note = await page.locator('#messages .msg-system').last().innerText();
  check(/กำลังตรวจ/.test(note) && /Checking whether/.test(note), 'checking notice is a .msg-system bubble');
  check(await page.locator('#messages .msg-system[role=status]').count() === 0, 'no role=status on the bubble (#136 convention)');
  const live = await page.waitForFunction(() => /Checking whether/.test(document.getElementById('chatLive').textContent), null, { timeout: 2000 }).then(() => true, () => false);
  check(live, 'announced through #chatLive (System speaker): ' + await page.evaluate(() => document.getElementById('chatLive').textContent.slice(0, 40)));
  check(await page.locator('#sendBtn').isDisabled(), 'Send disabled while settling');
  check(await page.locator('#endBtn').isDisabled(), 'End disabled while settling');
  check(await page.evaluate(() => document.getElementById('input').readOnly), 'composer locked (readOnly) while settling');
  const t1 = await page.locator('#timer').innerText();
  await page.waitForTimeout(2200);
  const t2 = await page.locator('#timer').innerText();
  check(t1 === t2, `active-seconds timer stopped during settle (${t1} -> ${t2})`);
  await bodyHas(page, 'STORED REPLY');
  check(store.posts.length === 1, 'exactly one POST (no blind retry)');
  check(UUID.test(store.posts[0].client_turn_id || ''), 'the POST carried a v4 client_turn_id');
  check(await count(page, '.msg-physician') === 1, 'one physician bubble');
  check(await page.locator('#messages .msg-act-btn:has-text("Retry")').count() === 0, 'no Retry offered');
  check(await page.locator('#turns').innerText() === '1', 'turn counter = turns + 1');
  check(await page.locator('#messages .msg-system').count() === 0, 'checking notice removed');
  check(!(await page.locator('#endBtn').isDisabled()), 'End re-enabled');
  check(await page.evaluate(() => sessionStorage.getItem('clics_turn_ple1')) === null, 'pending key cleared from sessionStorage');
});

await scenario(browser, base, 'B: nothing stored -> bounded window, then Retry with the SAME key', {
  useClock: true, keyed: true,
  onPost: ({ route, store, addTurn, body }) => {
    if (store.posts.length === 1) return route.abort('failed');
    addTurn(body.message, 'RETRY REPLY', body.client_turn_id);
    return json(route, 200, { message_id: 'a9', content: 'RETRY REPLY', refs: [], socratic_question: null, input_tokens: 1, output_tokens: 1 });
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system');
  const g0 = store.gets;
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  const polls = store.gets - g0;
  check(polls >= 30 && polls <= 50, `bounded polling window (${polls} reads at 3 s)`);
  const notice = await page.locator('#messages .msg-system').last().innerText();
  check(/ยังไม่ได้ส่ง/.test(notice) && /was not sent/.test(notice), 'not-received copy');
  check(await page.inputValue('#input') === text, 'text restored to the empty box');
  check(store.posts.length === 1, 'still one POST before the physician acts');
  await page.click('#messages .msg-act-btn:has-text("Retry")');
  await bodyHas(page, 'RETRY REPLY', 5000);
  check(store.posts.length === 2 && store.posts[1].client_turn_id === store.posts[0].client_turn_id, 'Retry reused the SAME client_turn_id');
  check(await count(page, '.msg-physician') === 1, 'one physician bubble after Retry');
});

await scenario(browser, base, 'C: 202 turn_pending -> polls, shows the stored reply (matched by key)', {
  keyed: true,
  onPost: ({ route, addTurn, addReply, body }) => {
    addTurn(text, null, body.client_turn_id);
    setTimeout(() => addReply('LATE REPLY'), 4000);
    return json(route, 202, { pending: true, code: 'turn_pending', retry_after_s: 5 });
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await bodyHas(page, 'LATE REPLY');
  check(store.posts.length === 1, 'one POST only');
});

await scenario(browser, base, 'D: 502 rimpl_unavailable -> ordinary failure, no polling', {
  onPost: ({ route }) => json(route, 502, { error: 'RIMPL unavailable: x', code: 'rimpl_unavailable' }),
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  check(store.gets <= 1, `no settle polling (gets=${store.gets})`);
  check(await page.inputValue('#input') === text, 'text restored');
});

await scenario(browser, base, 'E: two separate typed turns with the same text get different keys', {
  onPost: ({ route, store, addTurn, body }) => {
    addTurn(body.message, 'R' + store.posts.length);
    return json(route, 200, { message_id: 'a' + store.posts.length, content: 'R' + store.posts.length, refs: [], socratic_question: null });
  },
}, async ({ page, store }) => {
  for (let i = 1; i <= 2; i++) { await sendText(page, 'same text'); await bodyHas(page, 'R' + i, 5000); }
  check(store.posts[0].client_turn_id !== store.posts[1].client_turn_id, 'two different keys');
});

await scenario(browser, base, 'F: reload mid-turn; the server stores it meanwhile -> the reloaded page shows it, no re-send', {
  keyed: true,
  onPost: ({ store }) => new Promise(() => {}), // never answers: the reload kills it
}, async ({ page, store, addTurn }) => {
  await sendText(page, text);
  await page.waitForTimeout(300);
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('clics_turn_ple1')));
  check(saved && saved.key === store.posts[0].client_turn_id && saved.text === text, 'pending {key, text, sentAt} persisted in sessionStorage');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages .msg-system', { timeout: 5000 });
  check(await count(page, '.msg-physician') === 1, 'the unsettled question is back on screen after reload');
  addTurn(text, 'AFTER RELOAD', saved.key);
  await bodyHas(page, 'AFTER RELOAD');
  check(store.posts.length === 1, 'no second POST after the reload');
  check(await count(page, '.msg-physician') === 1, 'still one physician bubble');
  check(await page.evaluate(() => sessionStorage.getItem('clics_turn_ple1')) === null, 'pending cleared once settled');
});

await scenario(browser, base, 'G: reload, never stored -> Retry offered with the SAME key (cannotConfirm/notReceived copy)', {
  keyed: true, useClock: true,
  onPost: ({ route, store, addTurn, body }) => {
    if (store.posts.length === 1) return new Promise(() => {});
    addTurn(body.message, 'G REPLY', body.client_turn_id);
    return json(route, 200, { message_id: 'g1', content: 'G REPLY', refs: [], socratic_question: null });
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForTimeout(200);
  const key = store.posts[0].client_turn_id;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages .msg-system', { timeout: 5000 });
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  await page.fill('#input', '');
  await page.click('#messages .msg-act-btn:has-text("Retry")');
  await bodyHas(page, 'G REPLY', 5000);
  check(store.posts.length === 2 && store.posts[1].client_turn_id === key, 'Retry after reload reused the SAME key');
  check(await count(page, '.msg-physician') === 1, 'one physician bubble');
});

await scenario(browser, base, 'H: End answered 409 turn_in_flight -> bilingual toast, End usable again', {
  onPost: ({ route }) => json(route, 200, {}),
  onEnd: ({ route }) => json(route, 409, { error: 'A message is still being answered.', code: 'turn_in_flight' }),
}, async ({ page }) => {
  await page.click('#endBtn');
  await page.click('[data-act="ok"]');
  await page.waitForSelector('.toast', { timeout: 5000 });
  const t = await page.locator('.toast').last().innerText();
  check(/รอคำตอบ/.test(t) && /still being answered/.test(t), 'turn_in_flight toast is the Thai/English copy');
  check(!(await page.locator('#endBtn').isDisabled()), 'End re-enabled');
});

await scenario(browser, base, 'I: 409 turn_incomplete -> settles and retries under the SAME key, never a new one', {
  keyed: true, useClock: true,
  onPost: ({ route, store, addTurn, addReply, body }) => {
    if (store.posts.length === 1) {
      addTurn(body.message, null, body.client_turn_id);   // stored question, no reply (crash between inserts)
      return json(route, 409, { error: 'This message was saved without a reply.', code: 'turn_incomplete' });
    }
    addReply('REPAIRED REPLY');
    return json(route, 200, { message_id: 'r1', content: 'REPAIRED REPLY', refs: [], socratic_question: null });
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system');
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  const notice = await page.locator('#messages .msg-system').last().innerText();
  check(/Retry/.test(notice) && !/Refresh/.test(notice), 'cannotConfirm copy points at Retry, not Refresh');
  check(await page.evaluate(() => JSON.parse(sessionStorage.getItem('clics_turn_ple1') || 'null')?.key) === store.posts[0].client_turn_id, 'the key is still pending after turn_incomplete');
  await page.fill('#input', '');
  await page.click('#messages .msg-act-btn:has-text("Retry")');
  await bodyHas(page, 'REPAIRED REPLY', 5000);
  check(store.posts.length === 2 && store.posts[1].client_turn_id === store.posts[0].client_turn_id, 'turn_incomplete never re-keys: Retry used the SAME key');
});

await scenario(browser, base, 'J: Send is off until the history has loaded', {
  getDelayMs: 1500,
  onPost: ({ route }) => json(route, 200, { message_id: 'j', content: 'J', refs: [], socratic_question: null }),
}, async ({ page, store }) => {
  // scenario() already waited ~300 ms after DOMContentLoaded; the history GET is held for 1.5 s.
  check(await page.locator('#sendBtn').isDisabled(), 'Send disabled while the history loads');
  await page.fill('#input', 'too early');
  await page.press('#input', 'Enter');
  check(store.posts.length === 0, 'Enter before the history loads sends nothing');
  await page.waitForFunction(() => !document.getElementById('sendBtn').disabled, null, { timeout: 5000 });
  check(true, 'Send enabled once the history is drawn');
});

await scenario(browser, base, 'K: the settle window comes from the server (turn_ceiling_ms), not a constant', {
  useClock: true, ceiling: 10000,
  onPost: ({ route }) => route.abort('failed'),
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system');
  const g0 = store.gets;
  await pump(page, 30000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  const polls = store.gets - g0;
  check(polls >= 3 && polls <= 7, `a 10 s server ceiling gives a ~15 s window (${polls} reads), not 125 s`);
});

await scenario(browser, base, 'L: signing out clears every pending chat-turn key in the tab', {
  onPost: ({ route }) => route.abort('failed'),
}, async ({ page }) => {
  await page.evaluate(() => { sessionStorage.setItem('clics_turn_ple1', '{"key":"k","text":"t"}'); sessionStorage.setItem('clics_turn_other', '{}'); sessionStorage.setItem('keep_me', '1'); });
  await page.evaluate(() => window.api.logout());
  const left = await page.evaluate(() => Object.keys(sessionStorage));
  check(!left.some((k) => k.startsWith('clics_turn_')) && left.includes('keep_me'), 'api.logout() removed clics_turn_* only: ' + JSON.stringify(left));
});

await browser.close(); server.close();
console.log(fails.length ? `\nFAILED: ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
