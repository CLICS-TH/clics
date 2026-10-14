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

async function scenario(browser, base, name, { onPost, onEnd, keyed = false, useClock = false, ceiling = null, getDelayMs = 0, colorScheme = 'light', reducedMotion = 'no-preference' }, drive) {
  console.log('\n== ' + name);
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme, reducedMotion });
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
// Advance the page's fake clock in 3 s steps (one settle poll per step), yielding real time between
// steps so each poll's fetch can actually complete. 25 ms was enough on a laptop and not on a loaded
// CI runner, where polls were dropped and scenario B counted 28 reads instead of ~41.
const pump = async (page, ms) => {
  for (let i = 0; i < ms / 3000; i++) {
    await page.clock.runFor(3000);
    await page.waitForTimeout(120);
  }
};

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
  // The property under test is that polling REPEATS and then STOPS — the upper bound is the real
  // guard. The exact count depends on how many fake-clock steps land while a fetch is in flight, so
  // the lower bound stays loose enough to survive a slow runner without hiding an unbounded poll.
  check(polls >= 20 && polls <= 50, `bounded polling window (${polls} reads at 3 s)`);
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
  check(await count(page, '.msg-physician.is-pending .msg-pending') === 1, 'the redrawn, unconfirmed question is faded with its Sending line');
  addTurn(text, 'AFTER RELOAD', saved.key);
  await bodyHas(page, 'AFTER RELOAD');
  check(await count(page, '.msg-physician.is-pending, .msg-physician .msg-pending') === 0, 'found on settle: fade and Sending line gone');
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

// ---- the physician bubble of a lost turn: one on screen, whatever the physician does next ----
// Not received (read back, not there): the bubble comes down and the text goes back in the box. The check that
// skips a redraw follows the bubble element, not the text, so a same-text Send draws it again exactly once.
const lostThenAnswer = ({ route, store, addTurn, body }) => {
  if (store.posts.length === 1) return route.abort('failed');
  addTurn(body.message, 'REPLY ' + store.posts.length, body.client_turn_id);
  return json(route, 200, { message_id: 'm' + store.posts.length, content: 'REPLY ' + store.posts.length, refs: [], socratic_question: null });
};
const ownText = (page) => page.locator('#messages .msg-physician').evaluateAll((els) => els.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('')));

await scenario(browser, base, 'M: not received, then an EDITED re-send -> one bubble (the new text), new key', {
  useClock: true, keyed: true, onPost: lostThenAnswer,
}, async ({ page, store }) => {
  await sendText(page, 'Q2');
  await page.waitForSelector('#messages .msg-system');
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  check(/was not sent/.test(await page.locator('#messages .msg-system').last().innerText()), 'settled as not received');
  check(await count(page, '.msg-physician') === 0, 'not received: the unsent bubble is taken down');
  check(await page.inputValue('#input') === 'Q2', 'its text is back in the box');
  await page.fill('#input', 'Q2 edited');
  await page.press('#input', 'Enter');
  await bodyHas(page, 'REPLY 2', 5000);
  const bubbles = await ownText(page);
  check(bubbles.length === 1 && bubbles[0] === 'Q2 edited', 'exactly one bubble, the edited text: ' + JSON.stringify(bubbles));
  check(store.posts.length === 2 && store.posts[1].client_turn_id !== store.posts[0].client_turn_id, 'the edited text is a new turn: a new key');
  check(await count(page, '.msg-physician.is-pending') === 0, 'answered: not faded');
});

await scenario(browser, base, 'N: not received, then the SAME text re-sent with Send -> one bubble, same key', {
  useClock: true, keyed: true, onPost: lostThenAnswer,
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system');
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  check(await count(page, '.msg-physician') === 0, 'not received: the unsent bubble is taken down');
  await page.click('#sendBtn');   // the restored text, unchanged
  await page.waitForTimeout(100);
  check(await count(page, '.msg-physician') === 1, 'the same-text Send draws the question once (not zero: the redraw check reads the screen)');
  await bodyHas(page, 'REPLY 2', 5000);
  check(JSON.stringify(await ownText(page)) === JSON.stringify([text]), 'still one bubble once answered');
  check(store.posts.length === 2 && store.posts[1].client_turn_id === store.posts[0].client_turn_id, 'the same text re-sent under the SAME key');
});

// ---- pending bubble: faded with "กำลังส่ง… / Sending…" until the turn is confirmed stored ----
const PENDING = 'กำลังส่ง… / Sending…';
// WCAG contrast of an element's text against its real background (every fill on the way up, composited).
const CONTRAST = (el) => {
  const rgba = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  let under = { r: 255, g: 255, b: 255, a: 1 };
  const chain = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
  for (const n of chain.reverse()) { const bg = rgba(getComputedStyle(n).backgroundColor); if (bg.a > 0) under = over(bg, under); }
  const fg = over(rgba(getComputedStyle(el).color), under);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const a = lum(fg), b = lum(under);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
};
for (const theme of ['light', 'dark']) {
  await scenario(browser, base, `O (${theme}): in flight -> faded + Sending line, contrast >= 4.5; answered -> plain bubble`, {
    colorScheme: theme,
    onPost: async ({ route, addTurn, body }) => {
      await new Promise((r) => setTimeout(r, 1500));
      addTurn(body.message, 'O REPLY', body.client_turn_id);
      return json(route, 200, { message_id: 'o1', content: 'O REPLY', refs: [], socratic_question: null });
    },
  }, async ({ page }) => {
    check(await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'light') === theme, `theme is ${theme}`);
    await sendText(page, text);
    await page.waitForSelector('#messages .msg-physician.is-pending', { timeout: 2000 });
    await page.waitForTimeout(300);   // past the fade-in transition: measure the settled colours
    const label = await page.locator('#messages .msg-physician .msg-pending').innerText();
    check(label === PENDING, 'the Sending line reads "' + label + '"');
    const px = await page.locator('#messages .msg-physician .msg-pending').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    check(px >= 12, `Sending line ${px}px >= 12px (the 9pt micro floor, the .msg-time size)`);
    const cr = await page.locator('#messages .msg-physician.is-pending').evaluate(CONTRAST);
    const crLabel = await page.locator('#messages .msg-physician .msg-pending').evaluate(CONTRAST);
    check(cr >= 4.5 && crLabel >= 4.5, `faded bubble text ${cr}:1 and Sending line ${crLabel}:1 >= 4.5:1 (${theme})`);
    check(!/Sending|กำลังส่ง/.test(await page.evaluate(() => document.getElementById('chatLive').textContent)), 'the Sending line is not announced (#chatLive says the AI is thinking)');
    await bodyHas(page, 'O REPLY', 5000);
    check(await count(page, '.msg-physician.is-pending, .msg-physician .msg-pending') === 0, 'confirmed: the fade and the Sending line are gone');
    await page.waitForTimeout(300);
    const crDone = await page.locator('#messages .msg-physician').evaluate(CONTRAST);
    check(crDone >= 4.5, `stored bubble ${crDone}:1 (${theme})`);
  });
}

await scenario(browser, base, 'P: cannot confirm -> stays faded without the Sending line; Retry -> line back; answered -> plain', {
  keyed: true, useClock: true,
  onPost: ({ route, store, addTurn, addReply, body }) => {
    if (store.posts.length === 1) {
      addTurn(body.message, null, body.client_turn_id);   // question stored, reply missing: "unknown"
      return json(route, 409, { error: 'saved without a reply', code: 'turn_incomplete' });
    }
    addReply('P REPLY');
    return json(route, 200, { message_id: 'p9', content: 'P REPLY', refs: [], socratic_question: null });
  },
}, async ({ page }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-system');
  await pump(page, 135000);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  check(await count(page, '.msg-physician') === 1 && await count(page, '.msg-physician.is-pending') === 1, 'cannot confirm: the bubble stays, faded (it may be stored)');
  check(await count(page, '.msg-physician .msg-pending') === 0, 'no Sending line while nothing is being sent');
  await page.fill('#input', '');
  await page.click('#messages .msg-act-btn:has-text("Retry")');
  await bodyHas(page, 'P REPLY', 5000);
  check(await count(page, '.msg-physician') === 1, 'Retry does not draw a second bubble');
  check(await count(page, '.msg-physician.is-pending, .msg-physician .msg-pending') === 0, 'answered: plain bubble');
});

await scenario(browser, base, 'P2: Retry on a cannot-confirm turn shows the Sending line again while it runs', {
  keyed: true,
  onPost: ({ route, store, addTurn, body }) => {
    if (store.posts.length === 1) return json(route, 500, { error: 'x' });   // definite failure: bubble stays, unconfirmed
    return new Promise(() => {});                                              // the Retry hangs: in flight
  },
}, async ({ page }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  check(await count(page, '.msg-physician.is-pending') === 1 && await count(page, '.msg-physician .msg-pending') === 0, 'failed: faded, no Sending line');
  await page.fill('#input', '');
  await page.click('#messages .msg-act-btn:has-text("Retry")');
  await page.waitForSelector('#messages .msg-physician .msg-pending', { timeout: 2000 });
  check(await count(page, '.msg-physician') === 1, 'Retry in flight: one bubble, with the Sending line');
});

for (const motion of ['reduce', 'no-preference']) {
  await scenario(browser, base, `Q (${motion}): the fade transition respects prefers-reduced-motion`, {
    reducedMotion: motion,
    onPost: () => new Promise(() => {}),
  }, async ({ page }) => {
    await sendText(page, text);
    await page.waitForSelector('#messages .msg-physician.is-pending', { timeout: 2000 });
    const d = await page.locator('#messages .msg-physician').evaluate((e) => getComputedStyle(e).transitionDuration);
    check(motion === 'reduce' ? /^0s(, 0s)*$/.test(d) : d !== '0s', `transition-duration ${d}`);
  });
}

await scenario(browser, base, 'R: unkeyed backend, 500 after the question was stored (orphan), then reload -> stored bubble kept', {
  useClock: true, keyed: false,
  onPost: ({ route, addTurn, body }) => { addTurn(body.message, null); return json(route, 500, { error: 'Failed to save the message. Please try again.' }); },
}, async ({ page, store }) => {
  await sendText(page, text);
  await page.waitForSelector('#messages .msg-act-btn:has-text("Retry")', { timeout: 5000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  check(await count(page, '.msg-physician') === 1, 'one physician bubble after reload (history row adopted)');
  await pump(page, 135000);
  await page.waitForTimeout(300);
  check(store.messages.filter((m) => m.role === 'physician').length === 1, 'one stored physician row');
  check(await count(page, '.msg-physician') === 1, 'the stored question stays on screen after the settle');
  const notice = (await page.locator('#messages .msg-system').allInnerTexts()).join(' | ');
  check(/Could not confirm/.test(notice) && !/was not sent/.test(notice), 'cannot-confirm copy, never "was not sent", for a stored question');
});

// ---- Streamed replies (backend setting chat_streaming; js/api.js readEventStream, ple-chat.js liveReply) ----
const sse = (route, events) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8' },
  body: events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join('') });

await scenario(browser, base, 'S: streamed reply -> the stored reply is drawn once, the live bubble is gone, the POST asked to stream', {
  keyed: true,
  onPost: ({ route, body, addTurn }) => {
    addTurn(body.message, 'Amoxicillin 1 g tds (BTS, 2019).', body.client_turn_id);
    return sse(route, [['delta', { text: 'Amoxicillin ' }], ['delta', { text: '1 g tds (BTS, 2019).' }],
      ['done', { status: 200, body: { message_id: 'a1', content: 'Amoxicillin 1 g tds (BTS, 2019).', refs: [{ source: 'BTS' }], socratic_question: null, input_tokens: 5, output_tokens: 5 } }]]);
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await bodyHas(page, 'Amoxicillin 1 g tds');
  check(store.posts[0].stream === true, 'the POST asked for a stream');
  check(await count(page, '.msg-streaming') === 0, 'no live bubble left behind');
  check(await count(page, '.typing-dots') === 0, 'no typing dots left behind');
  check(await count(page, '.msg-assistant:not(.msg-system)') === 1, 'exactly one assistant reply');
  check(await count(page, '.ref-chip') === 1, 'refs come from the stored turn');
  check(await page.locator('#turns').innerText() === '1', 'turn counted once');
  check(await page.evaluate(() => sessionStorage.getItem('clics_turn_ple1')) === null, 'pending key cleared');
});

await scenario(browser, base, 'T: streamed then replaced -> only the corrected reply remains', {
  onPost: ({ route, body, addTurn }) => {
    addTurn(body.message, 'CORRECTED (NICE, 2023).');
    return sse(route, [['delta', { text: 'DRAFT WITHOUT CITATION' }], ['replace', { reason: 'citation' }], ['delta', { text: 'CORRECTED (NICE, 2023).' }],
      ['done', { status: 200, body: { message_id: 'a1', content: 'CORRECTED (NICE, 2023).', refs: [], socratic_question: null } }]]);
  },
}, async ({ page }) => {
  await sendText(page, text);
  await bodyHas(page, 'CORRECTED (NICE, 2023).');
  check(!(await page.evaluate(() => document.body.innerText.includes('DRAFT WITHOUT CITATION'))), 'the replaced draft is not on screen');
  check(await count(page, '.msg-assistant:not(.msg-system)') === 1, 'one assistant reply');
});

await scenario(browser, base, 'U: stream breaks off before done -> settled like a dropped connection (reads back, never re-sent)', {
  keyed: true,
  onPost: ({ route, body, addTurn }) => {
    addTurn(body.message, 'STORED AFTER BREAK', body.client_turn_id);
    return sse(route, [['delta', { text: 'half a rep' }]]);   // no done event
  },
}, async ({ page, store }) => {
  await sendText(page, text);
  await bodyHas(page, 'STORED AFTER BREAK');
  check(store.posts.length === 1, 'exactly one POST (no blind retry)');
  check(store.gets >= 2, `the episode was read back (gets=${store.gets})`);
  check(await count(page, '.msg-streaming') === 0, 'no live bubble left behind');
});

await scenario(browser, base, 'V: a streamed error (done 503 ai_busy) -> the usual busy notice and the text restored', {
  onPost: ({ route }) => sse(route, [['delta', { text: 'Amox' }], ['done', { status: 503, body: { error: 'busy', code: 'ai_busy', retry_after_s: 20 } }]]),
}, async ({ page }) => {
  await sendText(page, text);
  await bodyHas(page, 'AI is busy');
  check(/20/.test(await page.locator('#messages .msg-system').last().innerText()), 'wait taken from the body');
  check(await page.inputValue('#input') === text, 'text restored');
  check(await count(page, '.msg-streaming') === 0, 'no live bubble left behind');
});

await scenario(browser, base, 'W: the live bubble itself (liveReply): text grows, artifact fence held back, replace note, hidden from screen readers', {
  onPost: ({ route }) => json(route, 200, {}),
}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const b = document.createElement('div'); b.className = 'msg-assistant';
    b.innerHTML = '<div class="typing-dots"></div>';
    document.getElementById('messages').appendChild(b);
    const live = liveReply(b, () => {});
    const tick = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    live.onEvent('delta', { text: 'First **part**' }); await tick();
    const a = b.querySelector('.msg-stream-body').innerText;
    live.onEvent('delta', { text: '\n:::artifact{type="ddx"}\n| a | b |' }); await tick();
    const fence = b.querySelector('.msg-stream-body').innerText;
    const strong = !!b.querySelector('.msg-stream-body strong');
    live.onEvent('replace', { reason: 'language' }); await tick();
    const afterReplace = b.querySelector('.msg-stream-body').innerText;
    const note = b.querySelector('.typing-note');
    const md = !!markdownFragment('x');   // the markdown libs load from a CDN this smoke blocks
    return { md, a, fence, strong, afterReplace, noteShown: !note.hidden, noteText: note.innerText,
      hidden: b.querySelector('.msg-stream-body').getAttribute('aria-hidden'), dots: !!b.querySelector('.typing-dots') };
  });
  // With the libs: sanitised markdown. Without them (this smoke): plain text, never raw HTML.
  check(r.a.trim() === (r.md ? 'First part' : 'First **part**'), `text drawn as it arrives (${JSON.stringify(r.a)}, markdown ${r.md ? 'on' : 'off'})`);
  check(r.strong === r.md, 'markdown when the libs are there, plain text when not');
  check(!/artifact|\| a \|/.test(r.fence), 'the :::artifact block is held back');
  check(r.afterReplace.trim() === '' && r.noteShown && /Refining/.test(r.noteText), 'replace clears the text under the refining note');
  check(r.hidden === 'true', 'live text is aria-hidden (the finished reply is announced once)');
  check(!r.dots, 'typing dots replaced');
});

await browser.close(); server.close();
console.log(fails.length ? `\nFAILED: ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
