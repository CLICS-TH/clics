import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../../../physician-ui/public', import.meta.url));
const SCENES = fileURLToPath(new URL('../promo/compositions', import.meta.url));
const MAX_BYTES = 25 * 1024 * 1024;
const BANNED = [/on[-\s]?premise/i, /validated/i, /ติดตั้งภายในองค์กร/];
// The scenes built on screens that show a score: each must carry the booth's demo label.
const SCORED_SCENES = ['score.html', 'audit.html', 'boothB.html'];

/** The facts the kiosk needs from an MP4, read from its boxes: duration, video codec and size, audio tracks. */
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
  const moov = boxes(0, buf.length).find((b) => b.type === 'moov');
  const mvhd = child(moov, 'mvhd');
  const v1 = buf[mvhd.body] === 1;
  const timescale = buf.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
  const tracks = boxes(moov.body, moov.end).filter((b) => b.type === 'trak').map((trak) => {
    const mdia = child(trak, 'mdia');
    const handler = buf.toString('latin1', child(mdia, 'hdlr').body + 8, child(mdia, 'hdlr').body + 12);
    const stsd = child(child(child(mdia, 'minf'), 'stbl'), 'stsd');
    const tkhd = child(trak, 'tkhd');
    const wAt = tkhd.body + (buf[tkhd.body] === 1 ? 88 : 76);
    return { handler, format: buf.toString('latin1', stsd.body + 12, stsd.body + 16), width: buf.readUInt32BE(wAt) >>> 16, height: buf.readUInt32BE(wAt + 4) >>> 16 };
  });
  return { seconds: duration / timescale, tracks };
}

export default [
  {
    name: 'promo: the loop manifest\'s video is an H.264 1080x1920 silent MP4 of 45-60 s, small enough for the offline cache',
    async run(h) {
      const manifest = JSON.parse(await readFile(join(PUBLIC, 'booth-loop', 'manifest.json'), 'utf8'));
      const promo = manifest.items.find((i) => i.type === 'video' && i.src === '/booth-loop/promo.mp4');
      if (!h.check(!!promo, 'promo: the loop manifest lists /booth-loop/promo.mp4')) return;
      const buf = await readFile(join(PUBLIC, promo.src)).catch(() => null);
      if (!h.check(!!buf, 'promo: the file is at physician-ui/public/booth-loop/promo.mp4')) return;
      h.check(buf.length <= MAX_BYTES, `promo: ${(buf.length / 1048576).toFixed(1)} MB <= 25 MB`);
      const { seconds, tracks } = readMp4(buf);
      const video = tracks.filter((t) => t.handler === 'vide');
      h.check(seconds >= 45 && seconds <= 60, `promo: ${seconds.toFixed(1)} s, within 45-60 s`);
      h.check(video.length === 1 && video[0].format === 'avc1' && video[0].width === 1080 && video[0].height === 1920,
        `promo: one H.264 (avc1) video track at 1080x1920 (${JSON.stringify(video)})`);
      h.check(!tracks.some((t) => t.handler === 'soun'), 'promo: no audio track, so it plays silently');
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
];
