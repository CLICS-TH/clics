#!/usr/bin/env node
/*
 * Readability audit — CONTRAST, Thai type floor, and text clipping (FIT), measured in a real browser.
 *
 * Why this exists alongside scripts/responsive/responsive-smoke.mjs rather than inside it: that smoke
 * ABORTS every external request, including Google Fonts, so its text renders in a fallback face. That
 * is fine for the overflow/tap-target checks it makes, and useless here — Thai metrics differ sharply
 * between Noto Sans Thai and whatever the system substitutes, so a FIT measurement taken without the
 * real webfont measures nothing. This script therefore lets the two font hosts through and blocks the
 * rest (no backend, no CDN scripts).
 *
 * It also runs each page in BOTH themes. Several tokens in this repo are identical across light and
 * dark (--destructive, --primary), which is exactly how a colour that passes in one and fails in the
 * other survives review.
 *
 * What it reports, per page × width × theme:
 *   1. CONTRAST  — every text-bearing element's computed colour against its painted background
 *                  (ancestors walked through transparents, alpha composited), as WCAG 2.1 ratio.
 *   2. THAI TYPE — any element containing Thai script rendered below the legibility floor. Thai is
 *                  not simply "small text": the loop (หัว) that distinguishes many letters closes up
 *                  before Latin becomes unreadable, and Thai stacks up to four levels vertically.
 *   3. CLIP      — text wider than the box that clips it (overflow hidden/clip, or a nowrap ancestor).
 *   4. BODY      — dashboard only: an element carrying the `text-sm` utility (its body size) with Thai
 *                  in it, rendered below the 11.5pt Thai body floor. It does not try to decide what is
 *                  "body" from the page — that cannot be done reliably — it checks that the BODY TOKEN
 *                  reaches its utility. That token is a width-scoped variable override in globals.css,
 *                  and it fails silently (back to 14px on every phone) if --text-sm is ever declared in
 *                  `@theme inline`. Elements whose own classes carry a variant size (md:text-base …)
 *                  are skipped, since which size applies there is the breakpoint's choice.
 *
 *   5. ROUTE     — the render landed on a different path than it asked for (a client role gate or a
 *                  stale fixture redirected it), so it measured another page under this one's name.
 *   6. MISSING   — dashboard only: a marker the page must show (DASH_PAGES `expect`) is absent, i.e.
 *                  the fixture no longer produces the state the page is in this gate for.
 *   7. PROSE     — dashboard only: Thai PROSE rendered at the `text-xs` caption size. text-xs is for
 *                  captions, labels, badges and metadata; an instruction, explanation, conclusion,
 *                  question or help paragraph belongs on text-sm, which carries the Thai body floor.
 *                  BODY above cannot see this — it checks the token, not which token a paragraph
 *                  chose. "Prose" is decided by the text of the paragraph that holds the run, never by
 *                  the class: ≥ 45 Thai characters, or ≥ 25 with a sentence end (. ! ? before a space
 *                  or the end). Exempt by role, not by length: controls and their labels (button, a,
 *                  label, legend, summary, radio/tab/option), anything inside a <table>, and text
 *                  truncated with an ellipsis — those are captions however long they run. Tuned
 *                  2026-10-16 against a hand-classified inventory of the dashboard's Thai text-xs
 *                  strings: it flags none of those kept as captions, and misses only short hints and
 *                  fragments that moved to text-sm with their paragraph rather than on their own. On
 *                  the build before that move it reported 61 paragraphs; after it, none.
 *
 * Colours are read in ANY CSS colour space. Tailwind v4 reaches getComputedStyle as oklch()/oklab()/
 * lab(); until 2026-10-16 this script parsed rgb() only, so palette classes went unmeasured and every
 * `/NN` tint was scored as if transparent.
 *
 * Exits non-zero if any AA failure, clip, wrong route, missing marker or caption-size Thai prose is
 * found, so it can gate CI.
 * READABILITY_ONLY=/reset,/admin/flagged narrows a run while iterating; the full run is the gate.
 *
 * Run:  node scripts/readability/audit.mjs
 *       DASH_URL=http://localhost:3002 node scripts/readability/audit.mjs   (adds the dashboard)
 *
 * Backend calls are answered from scripts/readability/fixtures.mjs — deliberately long Thai
 * content, never real data. Without it the dashboard renders its empty state and the audit
 * measures nothing: that is exactly how a dark-mode badge regression got past the first run.
 *       node scripts/readability/audit.mjs --json out.json
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixtureFor, AUDITOR_PLE_OPEN, AUDITOR_PLE_REVEALED } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// AA for body text. 3.0 is the large-text bar; we apply it at >=24px, or >=18.66px when bold, per WCAG.
const AA_BODY = 4.5;
const AA_LARGE = 3.0;
// Thai floor. 12px is where the loop detail starts to close; the dashboard already bumped its
// text-xs to 13px for exactly this reason (audit-dashboard/app/globals.css).
const THAI_MIN_PX = 12;
// Thai BODY floor: 11.5pt = 15.33px. audit-dashboard's text-sm is 0.96rem (15.36px) below 1280px and
// the stock 0.875rem on the 118% root (16.52px) at 1280px, so it clears this at every width.
const BODY_MIN_PX = 15.33;

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      let file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const WIDTHS = [{ w: 320, h: 700 }, { w: 375, h: 800 }, { w: 768, h: 1024 }, { w: 1280, h: 900 }];
const THEMES = ['light', 'dark'];

// The three CREC pages first — they are the reason this script exists — then the rest of the portal,
// since the token changes this audit drives are app-wide and can regress any of them.
const PORTAL_PAGES = [
  { path: '/ple-reflect?id=00000000-0000-4000-8000-000000000000', token: true },
  { path: '/identity', token: true },
  { path: '/acceptability', token: true }, { path: '/dashboard', token: true },
  { path: '/ple-new', token: true }, { path: '/lpdp', token: true },
  { path: '/payment', token: true }, { path: '/', token: false },
  // Also carry class="sub" and were missed in the first pass — .sub is now a global rule,
  // so every page that uses it is in this audit's blast radius.
  { path: '/ple-result', token: true }, { path: '/guest-chat', token: false },
  { path: '/forgot', token: false },
  { path: '/ple-chat?id=00000000-0000-4000-8000-000000000000', token: true },
  // The manual: long-form Thai prose, the densest text on the portal, and the one page whose whole
  // job is to be read. Public, so no token.
  { path: '/manual', token: false },
];
// Each dashboard page: its path, the ROLE it is rendered as, and what it must SHOW.
//
//   role    The dashboard gates several pages on the signed-in role in the client (overview, icc,
//           analyst, compensation: anyone else is pushed to /home). Rendered as the default
//           physician+can_audit, those pages measured /home instead — every render "passed" a page
//           nobody looked at. The ROUTE check below now fails a render that lands somewhere else.
//   expect  REQUIRED. Markers the render must contain: `text:…` (visible text) or `sel:…` (a visible
//           element), chosen so they appear only when the fixture's data does — a heading that also
//           renders on the empty or error state proves nothing.
//           A fixture that drifts from the page's API shape renders the empty state, and an empty
//           state passes. A missing marker is a MISSING finding, so a stale fixture fails the gate
//           instead of quietly shrinking what it measures.
const DASH_PAGES = [
  { path: '/admin/privacy', expect: ['text:PLE-102'] },
  { path: '/admin/identity', expect: ['text:4821'] },
  { path: '/admin/governance', role: 'superadmin', expect: ['text:oauth_identities', 'text:2026-08'] },
  { path: '/auditor/queue', expect: ['text:31200 tokens'] },
  // The auditor home carries both calibration radars, the only recharts <Legend>s in the app.
  { path: '/home', expect: ['sel:.recharts-legend-item-text'] },
  // Both halves: superadmin sees the payout ledger (and its amber "outstanding" figure), an admin the
  // council report. The query string only keeps the two labels apart; the page ignores it.
  { path: '/admin/compensation', role: 'superadmin', expect: ['text:฿2,500'] },
  { path: '/admin/compensation?as=admin', role: 'admin', expect: ['text:฿4,500'] },
  { path: '/admin/invites', role: 'superadmin', expect: ['text:revoked.account@example.ac.th'] },
  { path: '/admin/users', role: 'superadmin', expect: ['text:14/14', 'text:P-002'] },
  // The provider panel and the Local AI capacity card carry most of the overview's help text. Both
  // markers come from fixture data: the unbound-lock note needs evaluator_lock.manifest_bound false,
  // and 64,000 is the fixture's transcript cap, shown as the card's current value.
  { path: '/admin/overview', role: 'superadmin', expect: ['text:0.75', 'text:declared before locks were bound', 'text:64,000'] },
  // The integrity queue. Its severity badges paint text on a TINT (`bg-primary/12`,
  // `bg-destructive/10`), which is where --link and --destructive both fail as text and where
  // --coral-on-tint / --danger exist — so it is exactly the kind of page this gate is for. It had no
  // fixture and no markers until 2026-10-16, so all 8 renders measured "No sessions are flagged".
  // PLE-301 carries every signal's explanatory note and the paste-genre disclaimer, for PROSE.
  { path: '/admin/integrity', role: 'superadmin',
    expect: ['text:PLE-302', 'sel:[data-slot=badge]', 'text:PLE-301', 'text:Raw counts, not a conclusion'] },
  // ---- added 2026-10-16: pages a 26-route render pass found failing that this gate never opened.
  // ThreeWayIcc renders only for analyst/ethics/superadmin (the blinding guard), so it needs the role.
  // Its small-sample note and contract-rate figure were raw-palette amber; they are tokens now.
  // Markers here render only WITH data: the candidate's model_version comes from the three-way fixture
  // alone ("Three-way agreement", the frame heading, also renders on the panel's error state).
  { path: '/analyst', role: 'analyst', expect: ['text:deepseek-v3.1-local@2026-09', 'text:Small shared sample'] },
  { path: '/admin/icc', role: 'superadmin', expect: ['text:deepseek-v3.1-local@2026-09', 'text:0.710'] },
  // DomainScorer, both halves: the unscored form ("ยังไม่ให้คะแนน" per domain) and the submitted one
  // (the comment prompt at an extreme level, the AI reveal, both radars and the AI discussion).
  { path: `/auditor/ples/${AUDITOR_PLE_OPEN}`, expect: ['text:ยังไม่ให้คะแนน', 'text:ผู้ป่วยกังวลเรื่องภาระค่าใช้จ่าย'] },
  { path: `/auditor/ples/${AUDITOR_PLE_REVEALED}`,
    expect: ['text:A comment is expected at this level', 'sel:.recharts-legend-item-text'] },
  { path: '/admin/lpdp/p1', role: 'superadmin', expect: ['sel:.recharts-line'] },
  { path: '/admin/flagged', role: 'superadmin', expect: ['text:C5:'] },
  // No Supabase in the audit build, so /reset renders its "not configured" error at once — the same
  // red text the expired-link state uses.
  { path: '/reset', expect: ['text:Password reset is not configured'] },
  // The dashboard's longest help text, for PROSE: readiness's drift explanations, and the Model Lock
  // form's hints with a lock in force (so the re-lock warning and its typed confirmation render too).
  // Data-only markers: the evaluator-scope drift block needs the fixture's evaluator_drift_keys, the
  // re-lock confirmation needs a lock in force, and the model version is the fixture's candidate.
  { path: '/admin/ai-readiness', role: 'superadmin', expect: ['text:These belong to the scoring instrument', 'text:EVAL_MAX_TOKENS'] },
  { path: '/admin/evaluator-lock', role: 'superadmin', expect: ['sel:#lock-relock-confirm', 'text:CCME_LLM_v8.0+qwen-2.5-72b'] },
];

// ---- the in-page collector -------------------------------------------------------------------
// Returns raw records; all colour maths happens here so the page never ships a library.
function collect([thaiMinPx, bodyMinPx, proseCheck]) {
  // Any computed colour → sRGB + alpha. Chromium serialises a computed colour in the space it was
  // written in, so Tailwind v4 reaches getComputedStyle as `oklch(…)` (every raw palette class:
  // text-amber-800) and as `oklab(… / 0.12)` (every `/NN` opacity utility: bg-primary/12,
  // bg-destructive/10, bg-muted/60). An rgb()-only parser returned null for all of them: the text
  // was SKIPPED and the tint was treated as TRANSPARENT, so the badge was scored against the card
  // under it. Non-rgb values are drawn opaque onto a 1×1 canvas (the browser's own conversion) and
  // the alpha is read from the string, so a low alpha does not lose precision to premultiplication.
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
      g2d.fillStyle = SENTINEL; g2d.fillStyle = opaque;   // an unparseable value leaves the sentinel
      if (String(g2d.fillStyle).toLowerCase() !== SENTINEL) {
        g2d.clearRect(0, 0, 1, 1); g2d.fillRect(0, 0, 1, 1);
        const d = g2d.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a };
      }
    }
    memo.set(s, out);
    return out;
  };
  const over = (fg, bg) => ({          // composite fg over an opaque bg
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b, a: 1,
  });
  // Walk up until something actually paints, compositing every translucent layer on the way down.
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
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const THAI = /[฀-๿]/;

  // An element "owns" text if it has a direct non-empty text child — otherwise we'd score every
  // wrapper div against its descendants' text and drown in duplicates.
  const owns = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length);
  const sel = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  // An element is skipped only when a VARIANT SIZES IT — md:text-base, hover:text-lg,
  // group-data-[size=sm]/card:text-sm, @min-[768px]:text-base — because which size applies is then
  // the breakpoint's or state's choice. Two things do NOT skip it:
  //   * a variant that targets OTHER elements: `*:`, `**:`, or an arbitrary selector with a
  //     combinator — `[&_code]:text-[0.85em]` sizes the <code> inside the Markdown wrapper, not the
  //     wrapper, and skipping on it left every Markdown body unchecked;
  //   * an arbitrary text-[…] that is a COLOUR — `dark:hover:text-[#1a1714]` is on every default
  //     Button, and skipping on it left every text-sm button unchecked.
  const SIZE_UTIL = /^text-(xs|sm|base|lg|[2-9]?xl|fluid-|display|\[(length:)?([\d.]+(px|rem|em|%)|(max|min|clamp|calc)\())/;
  const sizesItself = (cls) => {
    const parts = []; let depth = 0, cur = '';
    for (const ch of cls) {                      // split on ':' outside [...] — brackets hold selectors
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ':' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (!parts.length || !SIZE_UTIL.test(cur)) return false;   // no variant, or not a size utility
    return !parts.some((v) => v === '*' || v === '**' || (v.startsWith('[') && /[_>+~]/.test(v.replace(/^\[&/, ''))));
  };
  const bareTextSm = (el) => {
    const c = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
    return c.some((x) => /^text-sm(\/\S+)?$/.test(x)) && !c.some(sizesItself);
  };

  // ---- prose at the caption size (check 7) ----
  // The text-xs size, read off a probe rather than hard-coded: it is 13px below 1280px and scales with
  // the root above it, so a constant would stop matching at the first desktop step.
  const xsProbe = document.createElement('span');
  xsProbe.className = 'text-xs'; xsProbe.textContent = 'x';
  document.body.appendChild(xsProbe);
  const xsPx = parseFloat(getComputedStyle(xsProbe).fontSize);
  xsProbe.remove();
  const atXs = (n) => Math.abs(parseFloat(getComputedStyle(n).fontSize) - xsPx) < 0.05;
  const CAPTION_ROLE = 'table, button, a, label, legend, summary, select, [role=button], [role=radio], [role=tab], [role=option]';
  // The paragraph a run belongs to: up through inline boxes (a BiLabel <span>, a <strong>) to the
  // first block. Its text is what a reader reads as one unit, so it is what decides "prose".
  const blockOf = (n) => {
    let b = n;
    while (b.parentElement && b.parentElement !== document.body && getComputedStyle(b).display.startsWith('inline')) b = b.parentElement;
    return b;
  };
  const isProse = (t) => {
    const th = (t.match(/[฀-๿]/g) || []).length;
    return th >= 45 || (th >= 25 && /[.!?](?=\s|$)/.test(t));
  };
  const proseSeen = new Set();

  const contrast = [], thai = [], clips = [], body = [], prose = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[disabled]')) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    // Visually-hidden text (.sr-only: a 1x1 clipped box) is for screen readers. Its text is deliberately
    // "wider than its clip box", and it has no painted pixels to score for contrast or Thai size.
    if (box.width <= 1 && box.height <= 1) continue;

    // ---- clipping: is the text wider than the box that clips it?
    // text-overflow:ellipsis is deliberate truncation, not a clip — flagging it reports a design
    // decision as a defect. A hard overflow:hidden with no ellipsis still counts.
    const ellipsis = cs.textOverflow === 'ellipsis';
    const clipped = !ellipsis && (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1;
    if (clipped) clips.push({ sel: sel(el), text: el.textContent.trim().slice(0, 60), over: el.scrollWidth - el.clientWidth });

    // ---- body floor: does the text-sm token reach the element that asks for it?
    if (bodyMinPx && bareTextSm(el) && THAI.test(el.textContent)) {
      const s = parseFloat(cs.fontSize);
      if (s < bodyMinPx) body.push({ sel: sel(el), size: s, text: el.textContent.trim().slice(0, 40) });
    }

    if (!owns(el)) continue;
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!text) continue;

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    if (proseCheck && THAI.test(text) && atXs(el) && !el.closest(CAPTION_ROLE)) {
      const blk = blockOf(el);
      const trunc = (n) => getComputedStyle(n).textOverflow === 'ellipsis';
      // A caption-size span inside a body-size paragraph (a unit, a date) is judged on its own text.
      const t = (atXs(blk) ? blk.innerText : el.textContent).replace(/\s+/g, ' ').trim();
      if (!proseSeen.has(blk) && !trunc(el) && !trunc(blk) && isProse(t)) {
        proseSeen.add(blk);
        prose.push({ sel: sel(blk), size, text: t.slice(0, 60) });
      }
    }
    if (THAI.test(text) && size < thaiMinPx) {
      thai.push({ sel: sel(el), size, text: text.slice(0, 40), font: cs.fontFamily.split(',')[0] });
    }

    // SVG text (chart ticks, reference-line labels) is painted by `fill`, not `color`. The two agree
    // only when fill is currentColor; a recharts default label carries its own grey fill.
    const svgText = el instanceof SVGElement && el.tagName !== 'foreignObject';
    let fg = (svgText && parseRgb(cs.fill)) || parseRgb(cs.color); if (!fg) continue;
    const bg = paintedBg(el);
    // The element's own opacity multiplies its text toward whatever is behind it. This is how a
    // "secondary" fade quietly costs contrast, so it must be part of the measurement.
    let eff = 1;
    for (let n = el; n; n = n.parentElement) eff *= parseFloat(getComputedStyle(n).opacity);
    // Hidden by an ANCESTOR's opacity (hover-revealed actions, for one). Not visible, not a finding.
    if (eff === 0) continue;
    if (eff < 1) fg = over({ ...fg, a: fg.a * eff }, bg);
    else if (fg.a < 1) fg = over(fg, bg);

    const large = size >= 24 || (weight >= 700 && size >= 18.66);
    contrast.push({
      sel: sel(el), fg: hex(fg), bg: hex(bg), size, weight,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      need: large ? 3.0 : 4.5,
      thai: THAI.test(text), text: text.slice(0, 40),
    });
  }
  return { contrast, thai, clips, body, prose };
}

// ---- runner ----------------------------------------------------------------------------------
const dashUrl = process.env.DASH_URL || '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const jsonAt = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const findings = [];
let checked = 0;

// READABILITY_ONLY=/reset,/admin/flagged narrows a run to the pages whose label contains one of the
// comma-separated parts — for iterating on a fix. The full run is the gate.
const only = (process.env.READABILITY_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = (label) => !only.length || only.some((s) => label.includes(s));

async function run(url, label, token, manualLang, { role = null, expect = [] } = {}) {
  if (!wanted(label)) return;
  for (const { w, h } of WIDTHS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
      // Fonts through, everything else blocked. This is the one deliberate difference from
      // responsive-smoke.mjs and the whole reason the numbers here can be trusted for Thai.
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        // Backend calls are FULFILLED, not forwarded: populated rows are the whole point, and a
        // real backend would put real transcripts in the audit.
        if (u.startsWith(API_BASE)) {
          return route.fulfill({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(fixtureFor(u)),
          });
        }
        if (u.startsWith(base) || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')) return route.continue();
        if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
        return route.abort();
      });
      await ctx.addInitScript(([t, tok, ml, r]) => {
        try {
          localStorage.setItem('clics_theme', t);
          localStorage.setItem('theme', t);
          // The manual holds both languages in the document and hides one. The hidden copy is
          // display:none, so an audit that only ever renders the default measures half the page —
          // and English runs longer than Thai, so it is the half more likely to overflow.
          if (ml) localStorage.setItem('clics_manual_lang', ml);
          if (tok) {
            localStorage.setItem('clics_token', 'audit');
            // Default: the dual-role physician, which passes the auditor gates. A page that gates on
            // another role (superadmin, analyst) names it in DASH_PAGES.
            const u = r ? { role: r, name: 'Audit', full_name_th: 'ผู้ตรวจสอบระบบ', can_audit: false }
              : { role: 'physician', name: 'Audit', can_audit: true };
            localStorage.setItem('clics_user', JSON.stringify(u));
            localStorage.setItem('user', JSON.stringify({ ...u, role: r || 'auditor' }));
          }
        } catch { /* storage unavailable */ }
      }, [theme, token, manualLang ?? null, role]);

      const page = await ctx.newPage();
      try {
        // 45s: the font CDN throttles once the run has issued a few hundred requests, and a
        // slow stylesheet stalls domcontentloaded. Retried once before it counts as an error.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }));
        // The dashboard sets dark via a class, the portal via data-theme. Force both, then let the
        // webfonts actually arrive — measuring before they land measures the fallback face.
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.toggle('dark', t === 'dark');
        }, theme);
        // Freeze motion BEFORE measuring: a fade-in samples a half-composited colour, which
        // reports as a contrast failure that does not exist once the page settles.
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(300);
        // The body check is the dashboard's: the portal has no `text-sm` utility, and its Thai
        // body floor is its own token (--fs-body-th in physician-ui main.css).
        const dash = label.startsWith('dash');
        const r = await page.evaluate(collect, [THAI_MIN_PX, dash ? BODY_MIN_PX : 0, dash]);
        checked++;
        const where = `${label} @${w}px ${theme}`;
        // Did the render measure the page it was asked for? A client-side role gate or a stale
        // fixture redirects, and the redirect target is then scored under this page's name.
        const landed = new URL(page.url()).pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
        const asked = new URL(url).pathname.replace(/\/$/, '') || '/';
        if (landed !== asked) findings.push({ kind: 'ROUTE', where, text: `${label}: landed on ${landed}` });
        // Did it render the STATE this page is in the gate for? (see DASH_PAGES `expect`)
        const missing = await page.evaluate((markers) => markers.filter((m) => {
          if (m.startsWith('text:')) return !document.body.innerText.includes(m.slice(5));
          return ![...document.querySelectorAll(m.slice(4))].some((e) => {
            const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0;
          });
        }), expect);
        for (const m of missing) findings.push({ kind: 'MISSING', where, text: `${label}: ${m}` });
        for (const c of r.contrast) if (c.ratio < c.need) findings.push({ kind: 'CONTRAST', where, ...c });
        for (const t of r.thai) findings.push({ kind: 'THAI', where, ...t });
        for (const c of r.clips) findings.push({ kind: 'CLIP', where, ...c });
        for (const b of r.body) findings.push({ kind: 'BODY', where, ...b });
        for (const p of r.prose) findings.push({ kind: 'PROSE', where, ...p });
      } catch (e) {
        findings.push({ kind: 'ERROR', where: `${label} @${w}px ${theme}`, text: String(e.message || e) });
      }
      await ctx.close();
    }
  }
}

for (const p of PORTAL_PAGES) await run(base + p.path, `portal${p.path}`, p.token);
// The manual again, in English. Same widths, same themes — a second full pass, because a
// translation is new text in the same boxes and the boxes are what fail.
await run(base + '/manual', 'portal/manual[en]', false, 'en');
if (dashUrl) {
  for (const p of DASH_PAGES) {
    // No markers means an empty or error state passes as a clean page, which is how /admin/integrity
    // measured nothing but "No sessions are flagged". Required, not optional.
    if (!Array.isArray(p.expect) || !p.expect.length) {
      if (wanted(`dash${p.path}`)) {
        findings.push({ kind: 'ERROR', where: `dash${p.path}`,
          text: 'no `expect` markers — every dashboard page must name what it renders (DASH_PAGES)' });
      }
    }
    await run(dashUrl.replace(/\/$/, '') + p.path, `dash${p.path}`, true, null, p);
  }
}

await browser.close();
server.close();

// ---- report ----------------------------------------------------------------------------------
// Collapse by (selector, fg, bg) — the same token failure repeats across widths and pages, and a
// list of 400 duplicates hides how few distinct problems there actually are.
const key = (f) => f.kind === 'CONTRAST' ? `${f.kind}|${f.sel}|${f.fg}|${f.bg}` : `${f.kind}|${f.sel}|${f.text}`;
const grouped = new Map();
for (const f of findings) {
  const k = key(f);
  if (!grouped.has(k)) grouped.set(k, { ...f, seen: [] });
  grouped.get(k).seen.push(f.where);
}
const rows = [...grouped.values()].sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));

console.log(`\nReadability audit: ${checked} page×width×theme renders`
  + `${dashUrl ? '' : '  (dashboard skipped — set DASH_URL to include it)'}\n`);
for (const r of rows) {
  if (r.kind === 'CONTRAST') {
    console.log(`CONTRAST  ${r.fg} on ${r.bg} → ${r.ratio}:1  (needs ${r.need})  ${r.size}px/${r.weight}${r.thai ? ' TH' : ''}`);
    console.log(`          ${r.sel}  "${r.text}"`);
  } else if (r.kind === 'THAI') {
    console.log(`THAI      ${r.size}px < ${THAI_MIN_PX}px floor  ${r.sel}  "${r.text}"  [${r.font}]`);
  } else if (r.kind === 'CLIP') {
    console.log(`CLIP      +${r.over}px past its clip box  ${r.sel}  "${r.text}"`);
  } else if (r.kind === 'BODY') {
    console.log(`BODY      text-sm rendered ${r.size}px < ${BODY_MIN_PX}px Thai body floor  ${r.sel}  "${r.text}"`);
  } else if (r.kind === 'PROSE') {
    console.log(`PROSE     Thai prose at the text-xs caption size (${r.size}px) — use text-sm  ${r.sel}  "${r.text}"`);
  } else if (r.kind === 'ROUTE') {
    console.log(`ROUTE     ${r.text}  (redirected: the render measured another page)`);
  } else if (r.kind === 'MISSING') {
    console.log(`MISSING   ${r.text}  (the fixture did not produce the state this page is gated for)`);
  } else {
    console.log(`ERROR     ${r.where}: ${r.text}`);
  }
  // Pages by name, not three sample renders: one selector (an SVG `tspan`) can fail on several pages.
  const pages = [...new Set(r.seen.map((w) => w.replace(/ @.*$/, '')))];
  const themes = [...new Set(r.seen.map((w) => w.split(' ').pop()))].filter((t) => t === 'light' || t === 'dark');
  console.log(`          ${r.seen.length}×${themes.length ? ` (${themes.join('+')})` : ''} on ${pages.join(', ')}`);
}
const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
if (rows.length) console.log(`\n${rows.length} distinct finding(s): ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
if (!rows.length) console.log('✅ no contrast failures, no Thai below the type floor, no clipped text'
  + `${dashUrl ? ', dashboard text-sm at or above the Thai body floor, no Thai prose at the caption size' : ''}.`);
if (jsonAt) { await writeFile(jsonAt, JSON.stringify(rows, null, 2)); console.log(`\njson → ${jsonAt}`); }
process.exit(rows.length ? 1 : 0);
