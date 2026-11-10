// Booth reply cache guards (#387, ADR 0011): when a typed booth answer may take the reply already given to an earlier
// answer at the same point of the same case version. Pure and package-free: scripts/booth/reply-cache-calibration.mjs
// runs these exact guards on the labelled pairs, and the calibration record binds this file's own sha256, so editing
// a guard switches reuse off until the pairs are run again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const THRESHOLD = 0.95;

const THAI_TERMS = ['ไม่', 'ห้าม', 'อย่า', 'งด', 'หยุด', 'เลิก'];
// Longest first, so "don't" is one term and "cannot" is never read as "not".
const ENGLISH_TERMS = ['discontinue', 'withhold', 'without', 'cannot', 'avoid', 'never', "don't", 'dont', 'stop', 'hold', "n't", 'not', 'no'];
const LATIN_LETTER = /\p{Script=Latin}/u;
const THAI_LETTER = /[฀-๿]/u;
const CLAUSE_MARK = /[,.;:!?()\n]/u;
const DIGIT = /\d/u;
// ห้า before ม is ห้าม, a term above, not five.
const THAI_NUMBER_WORDS = ['หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า(?!ม)', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'ยี่สิบ', 'สิบ', 'ร้อย', 'พัน', 'ครึ่ง'];
// Thai has no spaces, so a Thai run after a number can carry on past its unit into the next words.
const THAI_RUN_MAX_CHARS = 8;
const THAI_RUN = /[ก-๎]+/gu;
const UNIT_RUN = String.raw`[\p{Script=Latin}ก-๎µμ%]+\.?`;
// The unit is read ahead, not taken, so a number word inside a long Thai unit is still read as a number.
const NUMBER = new RegExp(String.raw`(\d+(?:,\d{3})*(?:\.\d+)?|(?:${THAI_NUMBER_WORDS.join('|')})+)(?=(?:\s*(${UNIT_RUN}(?:/${UNIT_RUN})*))?)`, 'gu');

/** NFC, curly apostrophes straight, Thai digits as 0-9, a bare leading point as 0., Latin lowercased, a whitespace
 *  run holding a line break as one line break and any other as one space. */
const normalised = (text) => text.normalize('NFC').replace(/[‘’]/gu, "'")
  .replace(/[๐-๙]/gu, (d) => String(d.charCodeAt(0) - 0x0E50))
  .replace(/(?<!\d)\.(?=\d)/gu, '0.')
  .replace(/\p{Script=Latin}+/gu, (s) => s.toLowerCase())
  .replace(/\s*\n\s*/gu, '\n').replace(/[^\S\n]+/gu, ' ').trim();

/** The term starting at `i`, if any. A Thai term may sit inside a word (Thai has no spaces); อย่าง is not อย่า. An
 *  English term may not follow a Latin letter, except n't. */
function termAt(s, i) {
  const thai = THAI_TERMS.find((t) => s.startsWith(t, i) && !(t === 'อย่า' && s[i + t.length] === 'ง'));
  if (thai) return thai;
  return ENGLISH_TERMS.find((t) => s.startsWith(t, i) && (t === "n't" || i === 0 || !LATIN_LETTER.test(s[i - 1])));
}

const between = (s, i, re) => re.test(s[i - 1] ?? '') && re.test(s[i + 1] ?? '');
// A point or comma inside a number (0.5, 110,000) ends no clause; a space between two Thai letters does.
const endsClause = (s, i) => (CLAUSE_MARK.test(s[i]) && !(/[.,]/u.test(s[i]) && between(s, i, DIGIT)))
  || (s[i] === ' ' && between(s, i, THAI_LETTER));

/** What a term governs: the text after it, leading spaces skipped, up to the end of its clause, with its spaces
 *  dropped (re-spacing a clause does not change what it says). */
function scopeAfter(s, start) {
  let i = start;
  while (s[i] === ' ') i += 1;
  const from = i;
  while (i < s.length && !endsClause(s, i)) i += 1;
  return s.slice(from, i).replaceAll(' ', '');
}

const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** The guard cues of a de-identified answer, sorted: one per negation or stop term with the clause it governs, and
 *  one per number with its unit. A number is a digit run or a run of THAI_NUMBER_WORDS; its unit is the run of Latin
 *  or Thai letters right after it (whitespace between dropped), '/'-joined runs and a trailing abbreviation point kept,
 *  whole but for each Thai run in it, which is cut to its first THAI_RUN_MAX_CHARS. Digests only, never text. Two
 *  answers may share a reply only when their cue lists are equal, so a negation added, removed or moved to another
 *  clause, or a number or unit changed as read here, always bypasses the cache. A number in other words, or Thai runs
 *  alike in their first THAI_RUN_MAX_CHARS, are left to the embedding and the labelled pairs. */
function cuesOf(text) {
  const s = normalised(text);
  const cues = [];
  for (let i = 0; i < s.length;) {
    const term = termAt(s, i);
    if (!term) { i += 1; continue; }
    cues.push(digest(['term', term, scopeAfter(s, i + term.length)]));
    i += term.length;
  }
  for (const [, number, unit = ''] of s.matchAll(NUMBER)) {
    cues.push(digest(['number', number.replaceAll(',', ''), unit.replace(THAI_RUN, (run) => run.slice(0, THAI_RUN_MAX_CHARS))]));
  }
  return cues.sort();
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? -1 : dot / Math.sqrt(na * nb);
}

const cueKey = (cues) => [...cues].sort().join(' ');

/** The id of the entry `query` may reuse: the most similar of the entries made by the same model with equal cues
 *  at cosine >= THRESHOLD (the first, which the backend sends newest first, on a tie), else null. */
function bestReusable(query, entries) {
  const cues = cueKey(query.cues);
  let best = null;
  let bestCosine = -Infinity;
  for (const entry of entries) {
    if (entry.model !== query.model || cueKey(entry.cues) !== cues) continue;
    const c = cosine(query.embedding, entry.embedding);
    if (c >= THRESHOLD && c > bestCosine) { best = entry.id; bestCosine = c; }
  }
  return best;
}

// The kinds of labelled pair a calibration counts (scripts/booth/reply-cache-pairs.json).
const KINDS = ['same', 'negated', 'unsafe'];
const CALIBRATION_FILE = path.join(__dirname, 'booth-cache-calibration.json');
const calibrationFile = () => process.env.BOOTH_CACHE_CALIBRATION_FILE || CALIBRATION_FILE;
const guardSha = () => crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');

/** Whether a calibration of these guards on `modelId` at THRESHOLD, over pairs of every kind, found zero unsafe
 *  reuses. Without that record rimpl only embeds and the backend only stores: nothing is reused. Which pair set it
 *  ran on is checked in CI (scripts/booth/reply-cache-calibration.test.mjs): rimpl's image holds no scripts/. */
function calibrated(modelId) {
  let record;
  try { record = JSON.parse(fs.readFileSync(calibrationFile(), 'utf8')); } catch { return false; }
  return record?.unsafe_reuses === 0 && record.model === modelId && record.threshold === THRESHOLD && record.guard_sha === guardSha()
    && KINDS.every((kind) => Number.isInteger(record.counts?.[kind]?.pairs) && record.counts[kind].pairs > 0);
}

module.exports = { THRESHOLD, KINDS, cuesOf, cosine, bestReusable, calibrated, guardSha, CALIBRATION_FILE, calibrationFile };
