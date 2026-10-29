import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcesDigest, promoDigest, LOCK, PROMO } from '../promo/lock.mjs';
import { installStub, SCORE, BOARD, TAG } from '../promo/stub.mjs';

const PUBLIC = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const PROMO_DIR = fileURLToPath(new URL('../promo', import.meta.url));
const SCENES = join(PROMO_DIR, 'compositions');
const PROMO_SRC = '/booth-loop/promo.mp4';
const MAX_BYTES = 25 * 1024 * 1024;
const BANNED = [/on[-\s]?premise/i, /validated/i, /ติดตั้งภายในองค์กร/];
// The scenes built on screens that show a score: each must carry the booth's demo label.
const SCORED_SCENES = ['score.html', 'audit.html', 'boothB.html'];
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
    name: 'promo: the loop manifest\'s video is an H.264 1080x1920 silent MP4 of 45-60 s that the kiosk\'s Chrome decodes and caches',
    async run(h) {
      const manifest = JSON.parse(await readFile(join(PUBLIC, 'booth-loop', 'manifest.json'), 'utf8'));
      const promo = manifest.items.find((i) => i.type === 'video' && i.src === PROMO_SRC);
      if (!h.check(!!promo, `promo: the loop manifest lists ${PROMO_SRC}`)) return;
      const buf = await readFile(PROMO).catch(() => null);
      if (!h.check(!!buf, 'promo: the file is at physician-ui/public/booth-loop/promo.mp4')) return;
      h.check(buf.length <= MAX_BYTES, `promo: ${(buf.length / 1048576).toFixed(1)} MB <= 25 MB`);
      const { seconds, tracks, moovFirst } = readMp4(buf);
      const video = tracks.filter((t) => t.handler === 'vide');
      h.check(seconds >= 45 && seconds <= 60, `promo: ${seconds.toFixed(1)} s, within 45-60 s`);
      h.check(video.length === 1 && video[0].format === 'avc1' && video[0].width === 1080 && video[0].height === 1920,
        `promo: one H.264 (avc1) video track at 1080x1920 (${JSON.stringify(video)})`);
      h.check(video.length === 1 && (video[0].profile === 66 || video[0].profile === 77),
        `promo: H.264 ${PROFILES[video[0]?.profile] ?? `profile ${video[0]?.profile}`}, a Baseline or Main 8-bit 4:2:0 stream`);
      h.check(moovFirst, 'promo: the moov box comes before mdat, so playback starts before the whole file arrives');
      h.check(!tracks.some((t) => t.handler === 'soun'), 'promo: no audio track, so it plays silently');
    },
  },
  {
    name: 'promo: the shipped MP4 is the one rendered from the committed sources (promo.lock.json)',
    async run(h) {
      const lock = JSON.parse(await readFile(LOCK, 'utf8').catch(() => '{}'));
      h.check(lock.sources === await sourcesDigest(),
        'promo: scenes, capture stub, Landing shots, fonts and the case vignette and step 1 match the render (else run scripts/booth/promo/render.sh)');
      h.check(lock.promo === await promoDigest(), 'promo: promo.mp4 is the file render.sh wrote');
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
      const unlabelled = SCORED_SCENES.filter((f) => !text[f]?.includes(h.DEMO_LABEL.th) || !text[f].includes(h.DEMO_LABEL.en));
      h.check(unlabelled.length === 0, `promo: the demo label, TH and EN, in ${SCORED_SCENES.join(', ')}${unlabelled.length ? ` (missing in ${unlabelled.join(', ')})` : ''}`);
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
