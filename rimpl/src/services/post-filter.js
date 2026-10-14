// The evidence-marker labels come from the prompt module, so the line the model is told to write and
// the line this file accepts are one definition (see the evidence-level section below).
const {
  EVIDENCE_LEVELS, EVIDENCE_TH_LABEL, EVIDENCE_EN_LABEL, EVIDENCE_TH_LABEL_SHORT, EVIDENCE_EN_LABEL_SHORT, evidenceLineFor,
} = require('../lib/prompts');

// (Source, Year) citations: "(" + at least one char + "," + optional whitespace + 4 digits + anything
// + ")". This used to be the regex /\([^)]+,\s*\d{4}[^)]*\)/g, which is O(n^2) in the length of the
// text (and worse with long whitespace runs) on input like "(a, (a, (a, ..." with no ")". It runs on
// the model's output AND, via stripNonProse, on text a physician typed, so it is a hand-written
// LINEAR scan with exactly the same matches. Why it is equivalent: `[^)]` cannot cross a ")", so every
// match of a "(" ends at the FIRST ")" after it; a later "(" before that ")" sees a suffix of the
// same content and can only match if the earlier one did. So each "(" ... ")" segment is tested once
// and a failed segment is skipped whole. tests/language-guard-metric.test.js diffs it against the
// regex on a randomised corpus.
function hasYearAfterComma(s, from, to) {
  // content is s[from, to); the comma needs one char before it inside the content.
  for (let c = s.indexOf(',', from + 1); c !== -1 && c < to; c = s.indexOf(',', c + 1)) {
    let k = c + 1;
    while (k < to && /\s/.test(s[k])) k++;
    if (k + 4 > to) continue;
    let digits = true;
    for (let d = 0; d < 4; d++) {
      const code = s.charCodeAt(k + d);
      if (code < 48 || code > 57) { digits = false; break; }
    }
    if (digits) return true;
  }
  return false;
}

// [{ start, end, inner }] for each citation; `end` is exclusive and includes the ")".
function citationSpans(text, { first = false } = {}) {
  const s = String(text ?? '');
  const spans = [];
  let i = s.indexOf('(');
  while (i !== -1) {
    const j = s.indexOf(')', i + 1);
    if (j === -1) break;
    if (hasYearAfterComma(s, i + 1, j)) {
      spans.push({ start: i, end: j + 1, inner: s.slice(i + 1, j) });
      if (first) break;
    }
    i = s.indexOf('(', j + 1);
  }
  return spans;
}

function hasCitation(content) {
  return citationSpans(content, { first: true }).length > 0;
}

function extractSocraticQuestion(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('❓')) return line.replace(/^❓\s*/, '');
  }
  return null;
}

function extractReferences(content) {
  return citationSpans(content).map(({ inner }) => ({ source: inner.trim(), title: inner.split(',')[0].trim() }));
}

// --- Evidence-level marker (CCME R5) -------------------------------------------------------------
//
// The line lib/prompts.js EVIDENCE_GUIDANCE asks for, as a checkable field:
//   ระดับหลักฐานของข้อแนะนำหลัก: <สูง|ปานกลาง|ต่ำ|ความเห็นผู้เชี่ยวชาญ|ไม่ได้ประเมิน>
//     (Evidence for the main recommendation: <high|moderate|low|expert opinion|not graded>)
// Built from EVIDENCE_LEVELS, the same table the prompt is built from, so the two cannot drift.
// Returns the level KEY: 'high' | 'moderate' | 'low' | 'expert' | 'not_graded' — a stable contract.
//
// WHAT IS ACCEPTED (a near-compliant line is READ, not re-asked — a retry costs a model call):
//   - the Thai part, the English part, or both: Thai first with the English in parentheses, or English
//     first with the Thai in parentheses;
//   - the full labels the prompt shows, or the short ones (ระดับหลักฐาน / Evidence);
//   - in the parenthesised part, the level alone without its label: "ระดับหลักฐาน: สูง (high)";
//   - English in any case; a full-width colon; any spacing inside "expert opinion" / "not graded";
//   - decoration around the whole line: surrounding whitespace, markdown bold (** / __) anywhere in it,
//     ONE italic wrapper (*…* or _…_), a leading > blockquote, ONE trailing "." or "。", and NBSP /
//     other space-like characters (read as a space) or zero-width characters (removed).
// WHAT IS NOT: a marker run into a prose line, a bulleted line, `inline code`, a level outside the five
// (e.g. "very low"), or any other text on the line. The prompt asks for the line on its own; a check
// that accepted every near-miss would stop being a check.
//
// WHAT DOES NOT COUNT. A marker line inside a fenced ``` code block or inside a :::artifact{...} block
// (fence syntax as in lib/transcript.js; an unterminated fence runs to the end, as in stripNonProse) is
// not a marker at all — neither counted nor treated as a conflict. The prompt keeps the marker in the
// conversational text, outside any fence.
//
// AMBIGUITY -> null. Several marker lines (even identical ones), or one whose Thai and English levels
// disagree ("สูง (Evidence: low)"), is not one checkable answer, so the result is null — the same as
// no marker — and the chat route's corrective retry asks for exactly one. Picking the first or the last
// would silently choose between two claims the model made.
//
// COST. stripNonProse runs this on a physician's message too, so it is linear: one pass over the lines,
// a line longer than EVIDENCE_LINE_MAX_CHARS is skipped before any regex sees it (the longest valid line
// is 104 chars), and no regex below has two adjacent unbounded quantifiers over overlapping classes.
const EVIDENCE_LINE_MAX_CHARS = 200;
const EVIDENCE_BY_TH = new Map(EVIDENCE_LEVELS.map((l) => [l.th, l.key]));
const EVIDENCE_BY_EN = new Map(EVIDENCE_LEVELS.map((l) => [l.en, l.key]));
const spaced = (s) => s.replace(/ /g, '[ \\t]+');   // "expert opinion", "for the main recommendation"
const TH_ALT = EVIDENCE_LEVELS.map((l) => l.th).join('|');
const EN_ALT = EVIDENCE_LEVELS.map((l) => spaced(l.en)).join('|');
// Longer label first in each alternation; anchored by the colon that must follow.
const TH_LABEL_RE = `(?:${EVIDENCE_TH_LABEL}|${EVIDENCE_TH_LABEL_SHORT})`;
const EN_LABEL_RE = `(?:${spaced(EVIDENCE_EN_LABEL)}|${spaced(EVIDENCE_EN_LABEL_SHORT)})`;
const COLON = '[ \\t]*[:：][ \\t]*';
const EVIDENCE_TH_FIRST = new RegExp(
  `^${TH_LABEL_RE}${COLON}(${TH_ALT})(?:[ \\t]*\\([ \\t]*(?:${EN_LABEL_RE}${COLON})?(${EN_ALT})[ \\t]*\\))?$`, 'i');
const EVIDENCE_EN_FIRST = new RegExp(
  `^${EN_LABEL_RE}${COLON}(${EN_ALT})(?:[ \\t]*\\([ \\t]*(?:${TH_LABEL_RE}${COLON})?(${TH_ALT})[ \\t]*\\))?$`, 'i');

const ZERO_WIDTH = /[­᠎​-‍⁠﻿]/g;
const SPACE_LIKE = /[   -   　]/g;
// Strip the decoration listed under WHAT IS ACCEPTED, nothing else.
function normalizeMarkerLine(line) {
  let t = line.replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ').replace(/\*\*|__/g, '').trim();
  t = t.replace(/^(?:>[ \t]*)+/, '');
  let dropped = false;
  const dropDot = () => {
    if (!dropped && /[.。]$/.test(t)) { t = t.slice(0, -1).trimEnd(); dropped = true; }
  };
  dropDot();   // "…)." and "*…*." both end in the dot
  if (t.length >= 2 && (t[0] === '*' || t[0] === '_') && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim();
  dropDot();   // "*….*"
  return t;
}

// One line -> a level key | 'conflict' (Thai and English disagree) | null.
function parseEvidenceLine(line) {
  if (typeof line !== 'string' || line.length > EVIDENCE_LINE_MAX_CHARS) return null;
  const t = normalizeMarkerLine(line);
  let th = null;
  let en = null;
  let m = EVIDENCE_TH_FIRST.exec(t);
  if (m) { th = m[1]; en = m[2] ?? null; } else {
    m = EVIDENCE_EN_FIRST.exec(t);
    if (!m) return null;
    en = m[1]; th = m[2] ?? null;
  }
  const fromTh = th == null ? null : EVIDENCE_BY_TH.get(th);
  const fromEn = en == null ? null : EVIDENCE_BY_EN.get(en.toLowerCase().replace(/[ \t]+/g, ' '));
  if (fromTh && fromEn && fromTh !== fromEn) return 'conflict';
  return fromTh || fromEn || null;
}

const CODE_FENCE_OPEN = /^[ \t]*```[^`]*$/;   // CommonMark: an opening fence's info string has no backtick
const CODE_FENCE_CLOSE = /^[ \t]*```[ \t]*$/;
const ARTIFACT_FENCE_OPEN = /^:::artifact\{[^}\n]*\}/;
const ARTIFACT_FENCE_CLOSE = /^:::[ \t]*$/;

// Every marker line OUTSIDE a fence, in order: [{ line, level }] where `line` is the 0-based index in
// content.split('\n') and `level` may be 'conflict'. Exported for the quality harness's placement check.
function findEvidenceMarkers(content) {
  const lines = String(content ?? '').split('\n');
  const found = [];
  let fence = null;   // null | 'code' | 'artifact'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (fence === 'code') { if (CODE_FENCE_CLOSE.test(line)) fence = null; continue; }
    if (fence === 'artifact') { if (ARTIFACT_FENCE_CLOSE.test(line)) fence = null; continue; }
    if (CODE_FENCE_OPEN.test(line)) { fence = 'code'; continue; }
    if (ARTIFACT_FENCE_OPEN.test(line)) { fence = 'artifact'; continue; }
    const level = parseEvidenceLine(line);
    if (level) found.push({ line: i, level });
  }
  return found;
}

// A level key ('high' | 'moderate' | 'low' | 'expert' | 'not_graded') | null — null when there is no
// marker, more than one, or a self-contradicting one (see AMBIGUITY above).
function extractEvidenceLevel(content) {
  const found = findEvidenceMarkers(content);
  return found.length === 1 && found[0].level !== 'conflict' ? found[0].level : null;
}

// SPLICE, DON'T ADOPT. The chat route's marker-only retry (EVIDENCE_RETRY_PROMPT.only) asks for the one
// line alone; this takes the level from that answer and writes the CANONICAL line for it into the FIRST
// reply, which already passed every other check and which, on a streamed turn, the physician has
// already been reading. Nothing else in `retryText` is used, so a rewrite can never drop an artifact or
// reword prose behind the physician's back.
//   - `retryText` must hold exactly ONE marker line (outside any fence) with a consistent level; else null.
//   - Any marker lines the first reply already had (two of them, or a self-contradicting one — which is
//     why the retry fired) are removed, so the result holds exactly one.
//   - Placement is the prompt's: natural mode -> appended as the last line; examiner mode -> inserted
//     directly above the LAST ❓ line, so the ❓ stays last (appended if there is none).
//   - The result must read back as exactly that level (an unterminated fence at the end of a truncated
//     reply would swallow an appended line); if it does not, null.
// Returns { text, level } or null. On null the caller keeps the first reply unchanged.
function spliceEvidenceLine(firstText, retryText, { socratic = false } = {}) {
  const found = findEvidenceMarkers(retryText);
  if (found.length !== 1 || found[0].level === 'conflict') return null;
  const { level } = found[0];
  const line = evidenceLineFor(level);
  const first = String(firstText ?? '');
  const stale = new Set(findEvidenceMarkers(first).map((mk) => mk.line));
  const lines = first.split('\n').filter((_, i) => !stale.has(i));
  let text = null;
  if (socratic) {
    let q = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim().startsWith('❓')) { q = i; break; }
    if (q >= 0) { lines.splice(q, 0, line); text = lines.join('\n'); }
  }
  if (text == null) {
    const base = lines.join('\n');
    text = base + (base === '' || base.endsWith('\n') ? '' : '\n') + line;
  }
  return extractEvidenceLevel(text) === level ? { text, level } : null;
}

// --- Language guard -------------------------------------------------------------------------------
//
// Thai share = Thai codepoints (U+0E00-U+0E7F) / (Thai codepoints + Latin letters). Digits,
// punctuation, emoji and whitespace are in neither term, so they cannot move the score.
// `thaiShare` is the RAW metric: it excludes nothing, and scripts/probe/thai-probe.mjs reports it
// unchanged. The production guard (`isLanguageMismatch`) first strips the spans below, because they
// are Latin by convention, not because the model chose English.
function thaiShare(text) {
  const t = String(text ?? '');
  const thai = (t.match(/[\u0E00-\u0E7F]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return thai + latin === 0 ? 0 : thai / (thai + latin);
}

// Below this a Thai question was answered substantially in English. Clinical Thai routinely runs
// 50-80% Thai characters (drug and lab names stay Latin), so the bar sits well under that.
const THAI_MIN_SHARE = 0.30;

// Fewer judged letters than this and there is too little signal to call a language: a one-line
// "OK" or a reply that is almost all code must not buy a second AI call.
const MIN_JUDGED_LETTERS = 20;

// What the guard IGNORES before measuring, and why:
//   - fenced ``` code blocks and `inline code`   (identifiers and syntax, not prose)
//   - whole :::artifact{...} ... ::: blocks      (the prompt puts DDx tables and care plans there,
//                                                 often in English; fence syntax as in
//                                                 lib/transcript.js. An unterminated block, e.g. a
//                                                 truncated reply, is stripped to the end)
//   - a "References" / "เอกสารอ้างอิง" heading and everything after it (a trailing reference list)
//   - URLs and markdown link targets             (Latin by nature)
//   - (Source, Year) citations                   (same pattern as hasCitation; source titles are
//                                                 often English even in a Thai answer, and the
//                                                 prompt REQUIRES them)
//   - evidence-level marker lines                (parseEvidenceLine; the prompt REQUIRES the line,
//                                                 bilingual, in every reply of either language. Each
//                                                 is 76-104 chars and 45-51% Thai by itself — above
//                                                 the 0.30 bar, so measuring it could never sink a
//                                                 Thai reply, but it WOULD lift a short English reply
//                                                 to a Thai question over the bar and hide it, and
//                                                 credit an English turn's reply with Thai it never
//                                                 wrote)
// Deliberately NOT ignored: drug names, lab names and abbreviations in running prose. They cannot be
// told apart from English prose by a regex, and the 0.30 bar already allows for them.
//
// COST. This runs on model output and, through isThaiMessage, on what a physician typed (and the
// guest route reaches it too), so every step must be linear. Rules for editing it: no two adjacent
// unbounded quantifiers over overlapping classes (that is what made the heading regex cubic), no
// nested quantifiers, and a class that a quantified group is scanning must not contain the group's own
// opener (the link regex excludes "]" for that reason). tests/language-guard-metric.test.js runs every
// step on pathological input under a time budget.
const MAX_PROSE_CHARS = 100000;   // a reply is <= a few thousand tokens; this only bounds a hostile input
// A heading line on its own: optional #/*/space decoration, the word, optional ":", "*", spaces.
const REFERENCES_HEADING = /^[ \t#*]*(?:References?|Bibliography|เอกสารอ้างอิง|บรรณานุกรม)[ \t*:]*$/im;

function stripNonProse(text) {
  let s = String(text ?? '');
  if (s.length > MAX_PROSE_CHARS) s = s.slice(0, MAX_PROSE_CHARS);
  s = s.replace(/^:::artifact\{[^}\n]*\}[^\n]*(?:\n[\s\S]*?^:::[ \t]*$|[\s\S]*$)/gm, ' ');
  // Whole marker lines, wherever they are (one inside a code block would be stripped as code anyway).
  // No cheap pre-check on the label: a zero-width character inside it would defeat one.
  s = s.split('\n').filter((line) => !parseEvidenceLine(line.replace(/\r$/, ''))).join('\n');
  const heading = REFERENCES_HEADING.exec(s);
  if (heading) s = s.slice(0, heading.index);
  s = s
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)\s\]]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
  // Citations last, by span, so the linear scanner above is the only thing that reads parentheses.
  let out = '';
  let at = 0;
  for (const { start, end } of citationSpans(s)) {
    out += s.slice(at, start) + ' ';
    at = end;
  }
  return out + s.slice(at);
}

// Is the PHYSICIAN's message substantially Thai? The client labels a turn 'th' when the message holds
// ANY Thai codepoint, so this is the real test of what language they wrote in. Measured on the first
// MESSAGE_SAMPLE_CHARS only (a message can be 5000 chars and arrives from outside), with the same
// exclusions as the reply measure. On-prem only: the caller uses just the boolean.
const MESSAGE_SAMPLE_CHARS = 1000;
function isThaiMessage(message) {
  return thaiShare(stripNonProse(String(message ?? '').slice(0, MESSAGE_SAMPLE_CHARS))) >= THAI_MIN_SHARE;
}

// True when the reply to a Thai-language turn is not substantially Thai. ONLY 'th' is policed: a
// Thai physician who writes English may accept Thai or English, so English is never forced.
function isLanguageMismatch(text, language, { min = THAI_MIN_SHARE } = {}) {
  if (language !== 'th') return false;
  const prose = stripNonProse(text);
  const letters = (prose.match(/[\u0E00-\u0E7FA-Za-z]/g) || []).length;
  if (letters < MIN_JUDGED_LETTERS) return false;
  return thaiShare(prose) < min;
}

module.exports = {
  hasCitation, extractSocraticQuestion, extractReferences,
  extractEvidenceLevel, findEvidenceMarkers, parseEvidenceLine, spliceEvidenceLine, EVIDENCE_LINE_MAX_CHARS,
  thaiShare, isLanguageMismatch, isThaiMessage, stripNonProse, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
  MAX_PROSE_CHARS, MESSAGE_SAMPLE_CHARS,
};
