import { LOOKS, DEFAULT_LOOK, BREAK, tagText } from './booth-copy.js';

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
  return e;
}

/** Thai puts spaces between phrases, not words, and the browser would break inside a word (เบา|หวาน). */
export const phrases = (text) => phraseNodes(text, []);

/** Text whose `**…**` pairs mark bold runs. A run is drawn inside the phrase spans it covers, one <strong> per
 *  phrase, so bold never splits a phrase. The server sends `**` only in pairs. */
export function markedPhrases(text) {
  const segs = text.split('**');
  let plain = '';
  const bold = [];
  segs.forEach((s, i) => { if (i % 2) bold.push([plain.length, plain.length + s.length]); plain += s; });
  return phraseNodes(plain, bold);
}

/** A reading ("39.2", "106/66", "93%") starts with a digit. Its unit after it is a sign, a word with a slash or a dot
 *  ("°C", "มก./ดล.", "ครั้ง/นาที") or a Thai unit word; its label before it ("อุณหภูมิ", "SpO2") is one short word.
 *  The three stay one phrase, so a line never ends between a label and its value. */
const READING = /^\d/;
const UNIT = /^(?:[%°]|\S*[/.]\S*$|(?:ปี|วัน|เดือน|สัปดาห์|ชั่วโมง|นาที|วินาที|ครั้ง|ครั้งต่อนาที|ลิตร|กิโลกรัม|องศาเซลเซียส|ด้าน|ขั้น)$)/;
const LABEL_MAX = 16;
const isLabel = (w, max = LABEL_MAX) => w !== undefined && !/\s/.test(w) && !READING.test(w) && w.replaceAll(BREAK, '').length <= max;

/** The phrases of `text`, each one <span class="ph"> a line never breaks unless it is wider than its column. In case
 *  text (`asCase`) the run before a reading is its label however long, and its words are drawn as caseParts. */
function phraseNodes(text, bold, asCase = false) {
  const parts = text.split(/( +)/).filter((p) => p !== '');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!READING.test(parts[i])) { out.push(parts[i]); continue; }
    let reading = parts[i];
    if (out.length >= 2 && isLabel(out[out.length - 2], asCase ? Infinity : LABEL_MAX)) reading = out.splice(-2).join('') + reading;
    if (parts[i + 2] && UNIT.test(parts[i + 2])) { reading += parts[i + 1] + parts[i + 2]; i += 2; }
    out.push(reading);
  }
  let at = 0;
  return out.map((p) => {
    const from = at;
    at += p.length;
    if (p.trim() === '') return p;
    if (!asCase && !bold.length && p.includes(BREAK)) return brokenPhrase(p);
    return el('span', { class: 'ph' }, ...(asCase ? caseParts(p) : bold.length ? boldRuns(p, from, bold) : [p]));
  });
}

/** A phrase whose copy places breaks in it (BREAK): pieces that never break, a <wbr> between two, so a line too narrow
 *  for the phrase ends only where the copy says, never inside a word. Inline, so the pieces fill a line as words do. */
const brokenPhrase = (p) => el('span', { class: 'ph-split' },
  ...p.split(BREAK).flatMap((piece, i) => [i ? el('wbr') : null, el('span', { class: 'ph-piece' }, piece)]));

const WORDS = new Intl.Segmenter('th', { granularity: 'word' });
/** Words that open a phrase: a case line too long for its column may end before one. และ and หรือ hold the words on
 *  both sides, so "ไข้และไอ" stays one piece, and an opener right after one of these stays with it ("ตั้งแต่เมื่อวาน"). */
const OPENS = new Set(['ด้วย', 'ที่', 'ใน', 'เมื่อ', 'ขณะ', 'ตั้งแต่', 'เพราะ', 'โดย', 'แต่', 'ซึ่ง', 'จน', 'เพื่อ', 'ระหว่าง']);
const HOLDS = new Set([...OPENS, 'และ', 'หรือ']);

/** One case phrase as the pieces a line may end between. A phrase wider than its column breaks only before a word
 *  that opens a phrase, found by the word segmenter, so never inside a word: "มาโรงพยาบาลชุมชน / ด้วยไข้และไอ 10 วัน".
 *  Its last word keeps the reading after it on the same line. A phrase that fits its column stays one line. */
function caseParts(p) {
  const space = p.indexOf(' ');
  const run = space === -1 ? p : p.slice(0, space);
  const reading = space === -1 ? '' : p.slice(space);
  if (!/[฀-๿]/.test(run)) return [p];
  const words = [...WORDS.segment(run)].map((s) => s.segment);
  const pieces = [[]];
  words.forEach((w, i) => {
    if (i && OPENS.has(w) && !HOLDS.has(words[i - 1])) pieces.push([]);
    pieces.at(-1).push(w);
  });
  const last = pieces.at(-1);
  const tail = reading ? [last.slice(0, -1).join(''), el('span', { class: 'ph-keep' }, last.at(-1) + reading)].filter(Boolean) : [last.join('')];
  if (pieces.length === 1) return tail;
  return [...pieces.slice(0, -1).map((piece) => el('span', { class: 'ph-part' }, piece.join(''))), el('span', { class: 'ph-part' }, ...tail)];
}

/** English, as the Thai: a number stays on one line with its unit and the word before it ("Temperature 39.2 °C,",
 *  "rate 24,", "342 mg/dL."), and the rest breaks at its spaces as usual. */
const EN_UNIT = /^(?:[%°]|\S*\/\S*|(?:h|hours?|days?|weeks?|months?|years?|minutes?|min|mmHg|kg|g|mL|L|units?|times)[,.;:)]?$)/;
const EN_LABEL = /^[A-Za-z][A-Za-z0-9-]{0,11}$/;
function readingNodes(text) {
  const parts = String(text ?? '').split(/( +)/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!READING.test(parts[i])) { out.push(parts[i]); continue; }
    let reading = parts[i];
    if (out.length >= 2 && EN_LABEL.test(out.at(-2))) reading = out.splice(-2).join('') + reading;
    if (parts[i + 2] && EN_UNIT.test(parts[i + 2])) { reading += parts[i + 1] + parts[i + 2]; i += 2; }
    out.push(el('span', { class: 'reading' }, reading));
  }
  return out.filter((p) => p !== '');
}

/** Phrase `p`, at offset `from` of the text, cut where a bold range [start, end) begins or ends. */
function boldRuns(p, from, bold) {
  const cuts = [...new Set([0, p.length, ...bold.flat().map((k) => k - from).filter((k) => k > 0 && k < p.length)])].sort((a, b) => a - b);
  return cuts.slice(1).map((end, i) => {
    const piece = p.slice(cuts[i], end);
    return bold.some(([a, b]) => from + cuts[i] >= a && from + cuts[i] < b) ? el('strong', {}, piece) : piece;
  });
}

/** The language of one text the server or the visitor wrote: Thai when it holds a Thai letter. */
export const textLang = (text) => (/[฀-๿]/.test(text) ? 'th' : 'en');

// The look lives in this page's memory only: a reload (Done, Start over, an idle reset) starts the next visitor at
// DEFAULT_LOOK, and nothing reaches any storage.
let look = DEFAULT_LOOK;
const listeners = new Set();

export const currentLook = () => look;

/** @param {(look: string) => void} fn called after every switch @returns {() => void} unsubscribe */
export function onLook(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const slotClass = (lang) => (lang === LOOKS[look].primary ? 'bi-main' : 'bi-sub');

/** Switches every bilingual text on the page by its slot classes alone. No node moves: the shell's ghost-tap guard
 *  reads an added node as freshly drawn and would swallow the next tap on it. */
export function setLook(next) {
  if (!Object.hasOwn(LOOKS, next)) return;
  look = next;
  const root = document.documentElement;
  root.dataset.look = next;
  root.dataset.both = String(LOOKS[next].both);
  root.lang = LOOKS[next].primary;
  for (const span of document.querySelectorAll('.bi > [lang]')) {
    span.classList.toggle('bi-main', slotClass(span.lang) === 'bi-main');
    span.classList.toggle('bi-sub', slotClass(span.lang) === 'bi-sub');
  }
  for (const e of document.querySelectorAll('[data-look-lang]')) e.lang = LOOKS[next].primary;
  for (const fn of [...listeners]) fn(next);
}

/** A booth tag names one visitor, so it shows once: in English wherever the look shows English, in Thai in the
 *  Thai-only look (booth.css). */
export const tagName = (tag) => el('span', { class: 'tag-name' },
  el('span', { class: 'tag-en', lang: 'en' }, tagText(tag, 'en')), el('span', { class: 'tag-th', lang: 'th' }, tagText(tag, 'th')));

/** Text whose copy holds a line break ("\n") draws each line as a block of its own (booth-bands.js SCALE_NOTE). */
const lines = (text, draw) => (text.includes('\n') ? text.split('\n').map((line) => el('span', { class: 'bi-line' }, ...draw(line))) : draw(text));

export const bi = (pair, cls = '') => el('span', { class: `bi ${cls}`.trim() },
  el('span', { class: `bi-th ${slotClass('th')}`, lang: 'th' }, ...lines(pair.th, phrases)),
  el('span', { class: `bi-en ${slotClass('en')}`, lang: 'en' }, ...lines(pair.en, readingNodes)));

/** A case's own text (its teaser, its vignette), wherever it shows: bi, with a too-wide Thai phrase broken as caseParts. */
export const caseBi = (pair, cls = '') => el('span', { class: `bi ${cls}`.trim() },
  el('span', { class: `bi-th ${slotClass('th')}`, lang: 'th' }, ...phraseNodes(pair.th, [], true)),
  el('span', { class: `bi-en ${slotClass('en')}`, lang: 'en' }, ...readingNodes(pair.en)));
