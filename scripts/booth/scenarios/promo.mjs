import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcesDigest, promoDigest, LOCK, PROMO, SERVED, REPO } from '../promo/lock.mjs';
import { installStub, SCORE, BOARD, TAG, KASE } from '../promo/stub.mjs';

const PUBLIC = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const PROMO_DIR = fileURLToPath(new URL('../promo', import.meta.url));
const SCENES = join(PROMO_DIR, 'compositions');
const CLIP = fileURLToPath(new URL('../fixtures/loop-clip.mp4', import.meta.url));
const PROMO_SRC = '/booth-loop/promo.mp4';
const MAX_BYTES = 25 * 1024 * 1024;
const BANNED = [/on[-\s]?premise/i, /validated/i, /ติดตั้งภายในองค์กร/];
// The scenes built on screens that show a score: each must carry the booth's demo label.
const SCORED_SCENES = ['result.html'];
// The owner's headline (#244 promo redesign): the reel opens on it, word for word.
const HEADLINE = 'การเรียนรู้ที่แท้จริง วัดจากกระบวนการคิด ไม่ใช่เวลา';
// H.264 profiles the kiosk's Chrome decodes in hardware and software alike, all 8-bit 4:2:0 when 66 or 77.
const PROFILES = { 66: 'Baseline', 77: 'Main', 100: 'High' };

/** The facts the kiosk needs from an MP4, read from its boxes. */
function readMp4(buf) {
  const boxes = (start, end) => {
    const out = [];
    for (let at = start; at + 8 <= end;) {
      let size = buf.readUInt32BE(at);
      let head = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
      if (size === 0) size = end - at;
      out.push({ type: buf.toString('latin1', at + 4, at + 8), body: at + head, end: at + size });
      at += size;
    }
    return out;
  };
  const child = (box, type) => boxes(box.body, box.end).find((b) => b.type === type);
  const top = boxes(0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const mvhd = child(moov, 'mvhd');
  const v1 = buf[mvhd.body] === 1;
  const timescale = buf.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
  const tracks = boxes(moov.body, moov.end).filter((b) => b.type === 'trak').map((trak) => {
    const mdia = child(trak, 'mdia');
    const handler = buf.toString('latin1', child(mdia, 'hdlr').body + 8, child(mdia, 'hdlr').body + 12);
    const stsd = child(child(child(mdia, 'minf'), 'stbl'), 'stsd');
    const entry = { body: stsd.body + 16, end: stsd.body + 8 + buf.readUInt32BE(stsd.body + 8) };
    const format = buf.toString('latin1', stsd.body + 12, stsd.body + 16);
    const tkhd = child(trak, 'tkhd');
    const wAt = tkhd.body + (buf[tkhd.body] === 1 ? 88 : 76);
    // avc1 sample entry: 78 bytes of fixed fields, then its child boxes; avcC byte 1 is the profile.
    const avcC = format === 'avc1' ? boxes(entry.body + 78, entry.end).find((b) => b.type === 'avcC') : null;
    return {
      handler, format, profile: avcC ? buf[avcC.body + 1] : null,
      width: buf.readUInt32BE(wAt) >>> 16, height: buf.readUInt32BE(wAt + 4) >>> 16,
    };
  });
  const order = top.map((b) => b.type);
  return { seconds: duration / timescale, tracks, moovFirst: order.indexOf('moov') < order.indexOf('mdat') };
}

/** Every font size the promo's scenes declare, as authored px. */
async function authoredFontSizes() {
  const files = ['index.html', ...(await readdir(SCENES)).filter((f) => f.endsWith('.html')).map((f) => join('compositions', f))];
  const sizes = [];
  for (const f of files) {
    for (const m of (await readFile(join(PROMO_DIR, f), 'utf8')).matchAll(/([^{}]*)\{[^}]*font-size:\s*([\d.]+)px/g)) {
      sizes.push({ where: `${f} ${m[1].trim()}`, px: Number(m[2]) });
    }
  }
  return sizes;
}

/** A page that serves the promo's sources at http://promo.test/, the capture fonts from the Portal's own copies. */
async function promoPage(h) {
  const k = await h.kiosk();
  const browser = k.ctx.browser();
  await k.close();
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://promo.test') return route.abort();
    const font = /^\/assets\/capture\/([\w-]+\.woff2)$/.exec(url.pathname);
    const file = font ? join(PUBLIC, 'fonts', font[1]) : join(PROMO_DIR, decodeURIComponent(url.pathname));
    const body = await readFile(file).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: '' });
    const type = { '.html': 'text/html', '.woff2': 'font/woff2', '.mp4': 'video/mp4' }[extname(file)] ?? 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body });
  });
  return { ctx, page: await ctx.newPage() };
}

/** The shipped promo playing on the loop at 1080x1920, with the loop board fed `board`. */
async function promoOnLoop(h, board) {
  const stub = h.makeStub({ routes: { 'GET /booth/board': () => ({ status: 200, body: { board } }) } });
  const k = await h.kiosk({ stub });
  await k.page.waitForFunction((src) => {
    const media = document.querySelector('.loop-media');
    const v = media?.querySelector('video');
    return media?.dataset.loopSrc === src && v?.videoWidth === 1080 && v.currentTime > 0 && document.querySelector('.loop-board')?.children.length > 0;
  }, PROMO_SRC, { timeout: 10_000 });
  return k;
}

export default [
  {
    name: 'promo: the loop manifest\'s video is an H.264 1080x1920 MP4 of 20-30 s that the kiosk\'s Chrome decodes and caches',
    async run(h) {
      const manifest = JSON.parse(await readFile(join(PUBLIC, 'booth-loop', 'manifest.json'), 'utf8'));
      const promo = manifest.items.find((i) => i.type === 'video' && i.src === PROMO_SRC);
      if (!h.check(!!promo, `promo: the loop manifest lists ${PROMO_SRC}`)) return;
      const buf = await readFile(PROMO).catch(() => null);
      if (!h.check(!!buf, 'promo: the file is at physician-ui/public/booth-loop/promo.mp4')) return;
      h.check(buf.length <= MAX_BYTES, `promo: ${(buf.length / 1048576).toFixed(1)} MB <= 25 MB`);
      const { seconds, tracks, moovFirst } = readMp4(buf);
      const video = tracks.filter((t) => t.handler === 'vide');
      h.check(seconds >= 20 && seconds <= 30, `promo: ${seconds.toFixed(1)} s, within 20-30 s, a reel that loops as a screen saver`);
      h.check(video.length === 1 && video[0].format === 'avc1' && video[0].width === 1080 && video[0].height === 1920,
        `promo: one H.264 (avc1) video track at 1080x1920 (${JSON.stringify(video)})`);
      h.check(video.length === 1 && (video[0].profile === 66 || video[0].profile === 77),
        `promo: H.264 ${PROFILES[video[0]?.profile] ?? `profile ${video[0]?.profile}`}, a Baseline or Main 8-bit 4:2:0 stream`);
      h.check(moovFirst, 'promo: the moov box comes before mdat, so playback starts before the whole file arrives');
      const sound = tracks.filter((t) => t.handler === 'soun');
      h.check(sound.length <= 1 && sound.every((t) => t.format === 'mp4a'), `promo: at most one AAC music track, which the loop plays muted (${JSON.stringify(sound)})`);
    },
  },
  {
    name: 'promo: the shipped MP4 is the one rendered from the committed sources (promo.lock.json)',
    async run(h) {
      const lock = JSON.parse(await readFile(LOCK, 'utf8').catch(() => '{}'));
      h.check(lock.sources === await sourcesDigest(),
        'promo: scenes, capture stub, music, fonts and the case teaser, vignette and step 1 match the render (else run scripts/booth/promo/render.sh)');
      h.check(lock.promo === await promoDigest(), 'promo: promo.mp4 is the file render.sh wrote');
    },
  },
  {
    name: 'promo: every file the booth page loads, and every file the capture served, is in the source digest',
    async run(h) {
      const k = await h.kiosk();
      const seen = new Set();
      k.page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.origin === new URL(k.page.url()).origin) seen.add(decodeURIComponent(url.pathname));
      });
      await k.page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('start');
      await k.close();
      const toFile = (p) => { const f = join(PUBLIC, p); return extname(f) ? f : `${f}.html`; };
      const pagePaths = [...seen].filter((p) => !p.startsWith('/booth-loop/') && p !== '/booth-sw.js').map(toFile);
      const served = JSON.parse(await readFile(SERVED, 'utf8').catch(() => '[]')).map((f) => join(REPO, f));
      const files = [...new Set([...pagePaths, ...served])].sort();
      const base = await sourcesDigest();
      const missed = [];
      for (const file of files) {
        const read = async (f, enc) => (f === file ? `${await readFile(f, 'utf8')}\n/* edit */` : readFile(f, enc));
        if (await sourcesDigest({ read }) === base) missed.push(file.slice(REPO.length));
      }
      h.check(pagePaths.length > 5 && missed.length === 0,
        `promo: an edit to any of ${files.length} booth page files (${pagePaths.length} loaded at /booth) moves the source digest${missed.length ? ` (not covered: ${missed.join(', ')})` : ''}`);
    },
  },
  {
    name: 'promo: its captions follow the copy rule, and every scene built on a scored screen carries the demo label',
    async run(h) {
      const files = (await readdir(SCENES)).filter((f) => f.endsWith('.html')).sort();
      const text = Object.fromEntries(await Promise.all(files.map(async (f) => [f,
        (await readFile(join(SCENES, f), 'utf8')).replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')])));
      const hits = files.flatMap((f) => BANNED.map((re) => re.exec(text[f].split(h.DEMO_LABEL.th).join('').split(h.DEMO_LABEL.en).join('')))
        .filter(Boolean).map((m) => `${f}: "${m[0]}"`));
      h.check(files.length > 0 && hits.length === 0, `promo: copy rule in ${files.length} scenes${hits.length ? `: ${hits.join('; ')}` : ''}`);
      const opening = (await readFile(join(SCENES, 'hook.html'), 'utf8').catch(() => '')).replace(/<(style|script)>[\s\S]*?<\/\1>/g, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      h.check(opening.startsWith(HEADLINE), `promo: the reel opens on the owner's headline "${HEADLINE}" (hook.html reads "${opening.slice(0, 60)}")`);
      // The admitted case is the one a visitor will play: no option of any of its steps (its diagnosis among them).
      const options = Object.values(KASE.banks).flatMap((b) => (Array.isArray(b.options) ? [b] : Object.values(b)))
        .flatMap((b) => b.options).flatMap((o) => [o.label?.th, o.label?.en, o.label]).filter((t) => typeof t === 'string' && t.length > 2);
      const leaks = files.flatMap((f) => options.filter((o) => text[f].includes(o)).map((o) => `${f}: "${o}"`));
      h.check(options.length > 9 && leaks.length === 0, `promo: no scene shows an option of the admitted case (${options.length} checked)${leaks.length ? `: ${leaks.join('; ')}` : ''}`);
      const unlabelled = SCORED_SCENES.filter((f) => !text[f]?.includes(h.DEMO_LABEL.th) || !text[f].includes(h.DEMO_LABEL.en));
      h.check(unlabelled.length === 0, `promo: the demo label, TH and EN, in ${SCORED_SCENES.join(', ')}${unlabelled.length ? ` (missing in ${unlabelled.join(', ')})` : ''}`);
    },
  },
  {
    name: 'promo: every line of text fits its box with the real fonts, and no Thai word can break across lines',
    async run(h) {
      const { ctx, page } = await promoPage(h);
      const style = (await readFile(join(PROMO_DIR, 'index.html'), 'utf8')).match(/<style>([\s\S]*?)<\/style>/)[1];
      const problems = [];
      let lines = 0;
      for (const f of (await readdir(SCENES)).filter((x) => x.endsWith('.html')).sort()) {
        // A scene's markup at rest: the template without its script, so every line sits where the timeline lands it.
        const body = (await readFile(join(SCENES, f), 'utf8')).match(/<template>([\s\S]*)<\/template>/)[1].replace(/<script>[\s\S]*?<\/script>/g, '');
        await page.route('http://promo.test/__scene.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>` }));
        await page.goto('http://promo.test/__scene.html');
        await page.evaluate(() => document.fonts.ready);
        const r = await page.evaluate(() => {
          const out = { lines: 0, bad: [] };
          // Kinetic lines are nowrap; a step header's title shares its row with the 168 px disc and a 40 px gap.
          for (const s of document.querySelectorAll('.ln > span')) {
            out.lines++;
            const step = s.closest('.step');
            const room = step ? step.getBoundingClientRect().width - 208 : s.closest('p').parentElement.getBoundingClientRect().width;
            const w = s.getBoundingClientRect().width;
            if (w > room + 0.5) out.bad.push(`"${s.textContent}" ${Math.round(w)} px in ${Math.round(room)} px`);
          }
          // Every other Thai paragraph is broken by hand at word boundaries and must not wrap on its own.
          for (const p of document.querySelectorAll('p[lang="th"]')) {
            if (p.querySelector('.ln')) continue;
            out.lines++;
            if (getComputedStyle(p).whiteSpace !== 'nowrap') out.bad.push(`"${p.textContent.slice(0, 24)}" can wrap mid-word (white-space ${getComputedStyle(p).whiteSpace})`);
            if (p.scrollWidth > p.clientWidth + 0.5) out.bad.push(`"${p.textContent.slice(0, 24)}" ${p.scrollWidth} px in ${p.clientWidth} px`);
          }
          return out;
        });
        lines += r.lines;
        problems.push(...r.bad.map((b) => `${f}: ${b}`));
      }
      h.check(lines > 20 && problems.length === 0, `promo: ${lines} lines fit their boxes${problems.length ? ` (${problems.join('; ')})` : ''}`);
      await ctx.close();
    },
  },
  {
    name: 'promo: the last frame is the first frame, so the reel loops as a screen saver without a seam',
    async run(h) {
      const { ctx, page } = await promoPage(h);
      // Byte ranges, or Chrome cannot seek and every frame read is frame 0.
      const mp4 = await readFile(PROMO);
      await page.route('http://promo.test/__promo.mp4', (route) => {
        const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
        const from = m ? Number(m[1]) : 0;
        const to = m?.[2] ? Number(m[2]) : mp4.length - 1;
        return route.fulfill({ status: m ? 206 : 200, body: mp4.subarray(from, to + 1),
          headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${from}-${to}/${mp4.length}` } : {}) } });
      });
      // Same origin as the video, or the canvas is tainted and cannot be read.
      await page.route('http://promo.test/__seam.html', (route) => route.fulfill({ status: 200, contentType: 'text/html',
        body: '<!doctype html><video muted playsinline preload="auto"></video><canvas width="270" height="480"></canvas>' }));
      await page.goto('http://promo.test/__seam.html');
      const diff = await page.evaluate(async () => {
        const v = document.querySelector('video');
        const c = document.querySelector('canvas').getContext('2d', { willReadFrequently: true });
        v.src = 'http://promo.test/__promo.mp4';
        await new Promise((r) => { v.onloadeddata = r; });
        const frameAt = async (t) => {
          await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
          c.drawImage(v, 0, 0, 270, 480);
          return c.getImageData(0, 0, 270, 480).data;
        };
        const compare = (a, b) => {
          let sum = 0;
          let worst = 0;
          for (let i = 0; i < a.length; i += 4) {
            const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
            sum += d;
            worst = Math.max(worst, d);
          }
          return { mean: sum / (a.length / 4), worst };
        };
        const first = await frameAt(0);
        const last = await frameAt(v.duration - 0.02);
        // A frame on the dark draw scene must differ, or the seeks did not land and the comparison proves nothing.
        const middle = compare(first, await frameAt(8));
        return { ...compare(first, last), middle: middle.mean };
      }).catch((e) => ({ error: String(e) }));
      h.check(diff.mean !== undefined && diff.mean < 1 && diff.worst < 48 && diff.middle > 10,
        `promo: first and last frame match at 270x480 (mean ${diff.mean?.toFixed(3)}, worst ${diff.worst} of 255; a mid-reel frame differs by ${diff.middle?.toFixed(1)}${diff.error ? `, ${diff.error}` : ''})`);
      await ctx.close();
    },
  },
  {
    name: 'promo: every caption meets the booth text floor at the size the loop displays it, 1080x1920',
    async run(h) {
      const k = await promoOnLoop(h, { today: [], event: [] });
      const stage = await k.page.locator('.loop-stage').evaluate((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      const scale = Math.min(stage.w / 1080, stage.h / 1920);
      const small = (await authoredFontSizes()).filter((s) => s.px * scale < h.FLOOR.textPx - 0.01);
      h.check(small.length === 0, `promo: shown at ${scale.toFixed(4)} on a ${Math.round(stage.w)}x${Math.round(stage.h)} stage, every caption >= ${h.FLOOR.textPx}px`
        + `${small.length ? ` (below: ${small.map((s) => `${s.where} ${s.px}px -> ${(s.px * scale).toFixed(2)}px`).join('; ')})` : ''}`);
      await k.close();
    },
  },
  ...[['an empty board', { today: [], event: [] }], ['a full board', BOARD]].map(([label, board]) => ({
    name: `promo: while it plays, nothing on the loop covers the video, with ${label}`,
    async run(h) {
      const k = await promoOnLoop(h, board);
      const hit = await k.page.evaluate(() => {
        const v = document.querySelector('.loop-media video');
        const r = v.getBoundingClientRect();
        const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const pic = { left: r.left + (r.width - v.videoWidth * s) / 2, top: r.top + (r.height - v.videoHeight * s) / 2 };
        pic.right = pic.left + v.videoWidth * s;
        pic.bottom = pic.top + v.videoHeight * s;
        const b = document.querySelector('.loop-board');
        const br = b.getBoundingClientRect();
        const shown = getComputedStyle(b).display !== 'none' && br.width > 0 && br.height > 0;
        const overlap = shown && br.left < pic.right && br.right > pic.left && br.top < pic.bottom && br.bottom > pic.top;
        return overlap ? `board y ${Math.round(br.top)}-${Math.round(br.bottom)} over video y ${Math.round(pic.top)}-${Math.round(pic.bottom)}` : null;
      });
      h.check(!hit, `promo: the loop board stays off the promo's frame (${hit ?? 'board hidden while it plays'})`);
      await k.close();
    },
  })),
  {
    name: 'promo: the shipped loop shows the board for part of every cycle, never over the promo, and never as a flash at mount',
    async run(h) {
      const manifest = JSON.parse(await readFile(join(PUBLIC, 'booth-loop', 'manifest.json'), 'utf8'));
      const boardItem = manifest.items.find((i) => i.type === 'board');
      const stub = h.makeStub({ routes: { 'GET /booth/board': () => ({ status: 200, body: { board: BOARD } }) } });
      // The shipped manifest, with a 1 s clip served under the promo's name so a whole cycle fits in the run.
      const k = await h.kiosk({ stub, files: { [PROMO_SRC]: CLIP } });
      // Every animation frame from the first paint: is the board shown, and what is the loop showing under it?
      await k.page.addInitScript(() => {
        window.__samples = [];
        window.__videos = 0;
        const tick = () => {
          const b = document.querySelector('.loop-board');
          const m = document.querySelector('.loop-media');
          const shown = !!b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 0;
          const v = m?.querySelector('video');
          if (v && !v.dataset.sampleId) v.dataset.sampleId = String(++window.__videos);
          window.__samples.push({ shown, kind: m?.dataset.loopKind ?? null, src: m?.dataset.loopSrc ?? null, video: v?.dataset.sampleId ?? null, t: v?.currentTime ?? null });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await k.page.reload({ waitUntil: 'domcontentloaded' });
      const reached = await k.page.waitForFunction(() => document.querySelector('.loop-media')?.dataset.loopKind === 'board', null, { timeout: 15_000 }).then(() => true, () => false);
      const early = await k.page.evaluate((src) => {
        const s = window.__samples;
        const first = s.findIndex((x) => x.kind === 'board');
        const before = first === -1 ? s : s.slice(0, first);
        const promo = before.filter((x) => x.src === src);
        const rewinds = promo.filter((x, i) => i > 0 && x.t < promo[i - 1].t - 0.2).length;
        return { shown: before.filter((x) => x.shown).length, promo: promo.length, videos: new Set(promo.map((x) => x.video)).size, rewinds };
      }, PROMO_SRC);
      const listed = manifest.items.filter((i) => i.type === 'video' && i.src === PROMO_SRC).length;
      h.check(listed === 2 && early.videos === 1 && early.rewinds === 1,
        `attract: the promo plays ${listed} times back to back on one <video>, rewound in place so the replay has no gap (${early.videos} elements, ${early.rewinds} rewinds)`);
      h.check(early.promo > 0 && early.shown === 0, `shipped loop: the board stays hidden from page load through the promo (${early.shown} frames shown in ${early.promo} promo frames)`);
      await h.sleep(500);
      const onBoard = await k.page.evaluate(() => {
        const b = document.querySelector('.loop-board');
        return { shown: getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 0, media: document.querySelectorAll('.loop-media video, .loop-media img').length };
      });
      h.check(!!boardItem && reached && onBoard.shown && onBoard.media === 0,
        `shipped loop: after the promo, a board item shows the board with no media under it (${JSON.stringify({ boardItem, reached, ...onBoard })})`);
      const back = boardItem && await k.page.waitForFunction((src) => document.querySelector('.loop-media')?.dataset.loopSrc === src, PROMO_SRC, { timeout: (boardItem.seconds + 10) * 1000 }).then(() => true, () => false);
      await h.sleep(500);
      const over = await k.page.evaluate(() => window.__samples.filter((s) => s.shown && s.kind !== 'board').length);
      h.check(!!back && over === 0, `shipped loop: the cycle returns to the promo, and in ${await k.page.evaluate(() => window.__samples.length)} frames the board never showed over anything but its own item (${over} frames over another)`);
      await k.close();
    },
  },
  {
    name: 'promo capture: only fixture content reaches a frame, and the result card and board agree on the score',
    async run(h) {
      const k = await h.kiosk();
      const base = new URL(k.page.url()).origin;
      const browser = k.ctx.browser();
      await k.close();
      // The capture's own context: a fresh one, service workers blocked, every request routed by installStub.
      const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      await installStub(ctx, base);
      const page = await ctx.newPage();
      const loopFiles = [];
      page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/booth-loop/') && p !== '/booth-loop/manifest.json') loopFiles.push(p); });
      await page.goto(base + '/booth', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#booth[data-shell="start"]', { timeout: 10_000 });
      const manifest = await page.evaluate(() => fetch('/booth-loop/manifest.json', { cache: 'no-store' }).then((r) => r.json()));
      await h.sleep(1500);
      h.check(h.same(manifest, { items: [] }) && loopFiles.length === 0 && await page.locator('.loop-media video, .loop-media img').count() === 0,
        `promo capture: the attract loop is empty, whatever the real manifest lists (${JSON.stringify(manifest)}; loop files requested: ${loopFiles.join(', ') || 'none'})`);
      await ctx.close();
      const row = (list) => list.find((e) => e.tag === TAG)?.score;
      const shown = [SCORE.composite, row(BOARD.today), row(BOARD.event)].map((n) => Math.round(n));
      h.check(shown.every((n) => n === shown[0]), `promo capture: Booth #0${TAG} shows one score on the card and both boards (${shown.join(', ')})`);
    },
  },
];
