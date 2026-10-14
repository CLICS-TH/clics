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
//   - decoration around the whole line: surrounding whitespace (but see NESTED below), markdown bold
//     (** / __) anywhere in it,
//     ONE italic wrapper (*…* or _…_), a leading > blockquote, ONE leading list marker (- * + • ‣ ◦ ▪
//     or 1. / 1)), ONE trailing "." or "。", and NBSP / other space-like characters (read as a space) or
//     zero-width characters (removed).
// WHAT IS NOT READ: a marker run into a prose line, a heading, a leading emoji, `inline code`, a level
// outside the five (e.g. "very low"), another label ("Level of evidence:"), a "สูง / high" pair, or any
// other text on the line such as a trailing citation. The prompt asks for the line on its own; a check
// that accepted every near-miss would stop being a check. Those near-misses are still RECOGNISED as
// evidence statements (isEvidenceStatementLine below), so the splice can remove the bare ones — and
// refuses to touch a reply whose near-miss carries anything more than a level.
//
// NESTED. An indented list item ("  - Evidence: high" under one option) or an indented block (4+ spaces
// or a tab) is content: it grades that option, not the reply's main recommendation, so it is neither read
// as the marker nor removed, and the reply-level line is never written over it.
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
// is 104 chars), every regex is anchored at the line start, and no two unbounded quantifiers over
// overlapping classes sit next to each other without a required literal between them (the near-miss
// regexes' label tails are bounded, {0,30} / {0,60} / {0,80}).
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

const ZERO_WIDTH = /[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/g;
const SPACE_LIKE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// ONE leading list marker: a bullet, or a number with "." or ")". It needs the space after it, so the
// italic wrapper "*…*" is not mistaken for a bullet.
const LIST_MARKER = /^(?:[-*+\u2022\u2023\u25E6\u25AA]|\d{1,3}[.)])[ \t]+/;
// Strip the decoration listed under WHAT IS ACCEPTED, nothing else.
function normalizeMarkerLine(line) {
  let t = line.replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ').replace(/\*\*|__/g, '').trim();
  t = t.replace(/^(?:>[ \t]*)+/, '').replace(LIST_MARKER, '');
  let dropped = false;
  const dropDot = () => {
    if (!dropped && /[.。]$/.test(t)) { t = t.slice(0, -1).trimEnd(); dropped = true; }
  };
  dropDot();   // "…)." and "*…*." both end in the dot
  if (t.length >= 2 && (t[0] === '*' || t[0] === '_') && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim();
  dropDot();   // "*….*"
  return t;
}

// A NESTED list item ("  - Evidence: high" under one option) or an indented block (4+ spaces or a tab:
// a list item's continuation, or code) belongs to the content above it. It grades that option, not the
// reply's main recommendation, so it is never the reply-level marker and never a statement to remove.
const NESTED_OR_INDENTED = /^(?: {1,3}(?:>[ \t]*)*(?:[-*+\u2022\u2023\u25E6\u25AA]|\d{1,3}[.)])[ \t]| {4}|\t)/;
function isNestedOrIndented(line) {
  return NESTED_OR_INDENTED.test(line);
}

// One line -> a level key | 'conflict' (Thai and English disagree) | null.
function parseEvidenceLine(line) {
  if (typeof line !== 'string' || line.length > EVIDENCE_LINE_MAX_CHARS || isNestedOrIndented(line)) return null;
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

// [{ i, line }] for every line OUTSIDE a fence, in order (`i` is the 0-based index in content.split('\n')).
function linesOutsideFences(content) {
  const lines = String(content ?? '').split('\n');
  const out = [];
  let fence = null;   // null | 'code' | 'artifact'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (fence === 'code') { if (CODE_FENCE_CLOSE.test(line)) fence = null; continue; }
    if (fence === 'artifact') { if (ARTIFACT_FENCE_CLOSE.test(line)) fence = null; continue; }
    if (CODE_FENCE_OPEN.test(line)) { fence = 'code'; continue; }
    if (ARTIFACT_FENCE_OPEN.test(line)) { fence = 'artifact'; continue; }
    out.push({ i, line });
  }
  return out;
}

// Every marker line OUTSIDE a fence, in order: [{ line, level }] where `line` is the 0-based index in
// content.split('\n') and `level` may be 'conflict'. Exported for the quality harness's placement check.
function findEvidenceMarkers(content) {
  const found = [];
  for (const { i, line } of linesOutsideFences(content)) {
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

// --- Near-miss evidence statements: recognised for REMOVAL only, never read as a level ------------
//
// The retry fires precisely because the first reply's evidence line did not parse. If the splice removed
// only the lines the strict parser reads, that near-miss would stay and the canonical line would land
// next to it: two evidence statements on screen, possibly disagreeing. So this LOOSER test recognises a
// line that, once its decoration is stripped (blockquote, # heading, list marker, leading emoji,
// bold/italic), is an evidence label, a colon and a LEVEL — and NOTHING ELSE:
//   - the label: the prompt's own labels, "Evidence level / grade / certainty / quality / rating",
//     "Level / grade / certainty / quality / strength of (the) evidence", "ระดับหลักฐาน…",
//     "คุณภาพ(ของ)หลักฐาน", "ความน่าเชื่อถือของหลักฐาน" (an optional "(…)" may sit before the colon), or
//     the bare "Evidence";
//   - the level: one of the five, in either language, as a WHOLE word (no Latin letter after an English
//     level, no Thai letter after a Thai one, so "สูง" never matches "สูงอายุ"), plus GRADE's "very low" /
//     ต่ำมาก and สูงมาก, optionally "X / Y", optionally followed by "certainty" or "quality"; after an
//     unambiguous label (not bare "Evidence") also a grade token such as "A", "B-R", "1a", "II";
//   - then at most two "(…)" of <= 80 chars each, an optional final full stop, and the END of the line.
// END-ANCHORED on purpose. "Evidence: low molecular weight heparin remains preferred …", "Evidence: high
// blood pressure accelerates …" and "Quality of evidence: two small RCTs (n=120) …" START like an evidence
// statement and are clinical content; a test that only looked at the start deleted them from correct
// replies. A line that starts with ❓ is never one (it is the examiner's question), nor is a NESTED list
// item or an indented block (see isNestedOrIndented). The test never yields a level, so it cannot make
// a near-miss count as compliant.
//
// DETECTED is not REMOVABLE. A detected line is removed only when everything after its level is itself
// level-like — "(Evidence for the main recommendation: high)", "(high)", "(GRADE)" — so no citation, trial
// size or other content goes with it (isRemovableEvidenceStatement). If ANY detected line is not removable,
// the splice refuses the whole change and the reply stands as it is: a second evidence statement on screen
// can be corrected later, a deleted clinical line cannot.
const LOOSE_LABEL_EN = `(?:${spaced(EVIDENCE_EN_LABEL)}|evidence[ \\t]+(?:level|grade|certainty|quality|rating)|(?:level|grade|certainty|quality|strength)[ \\t]+of[ \\t]+(?:the[ \\t]+)?evidence)`;
const LOOSE_LABEL_TH_ROOT = `(?:${EVIDENCE_TH_LABEL_SHORT}|คุณภาพ(?:ของ)?หลักฐาน|ความน่าเชื่อถือของหลักฐาน)`;
const LOOSE_LABEL_TH = `${LOOSE_LABEL_TH_ROOT}[^:：\\n]{0,30}`;
// ALLOWLIST: the label alone, or the prompt's own scope ("…ของข้อแนะนำหลัก" / "…ของข้อแนะนำนี้") or "overall".
// Any other suffix is a QUALIFIER — "ระดับหลักฐานในเด็ก", "…ในผู้ใหญ่", "…สำหรับผู้ป่วยไตวาย" — and a grade
// for one population or outcome is clinical content: still detected (LOOSE_LABEL_TH), never removed.
const LOOSE_LABEL_TH_REMOVABLE = `${LOOSE_LABEL_TH_ROOT}(?:ของข้อแนะนำ(?:หลัก|นี้)?|โดยรวม)?`;
const EN_LEVEL_WORD = `(?:very[ \\t-]+low|very[ \\t-]+high|${EN_ALT})(?![A-Za-z])`;
const TH_LEVEL_WORD = `(?:สูงมาก|ต่ำมาก|${TH_ALT})(?![\\u0E00-\\u0E7F])`;
const ONE_LEVEL = `(?:${EN_LEVEL_WORD}|${TH_LEVEL_WORD})`;
const LEVEL_VALUE = `${ONE_LEVEL}(?:[ \\t]*/[ \\t]*${ONE_LEVEL})?(?:[ \\t-]+(?:certainty|quality)(?![A-Za-z]))?`;
const GRADE_TOKEN = `(?:grade[ \\t]+)?(?:[A-D](?:-[A-Z]{1,3})?|[1-5][a-c]?|I{1,3}|IV)(?![A-Za-z0-9])`;
const PRE_COLON_PAREN = '(?:[ \\t]*\\([^)\\n]{0,60}\\))?';
// ALLOWLIST likewise: "(GRADE)" or "(overall)" only. "Level of evidence (adults): high", "Certainty of evidence
// (mortality): moderate" grade one population or outcome — content, detected (PRE_COLON_PAREN), never removed.
const PRE_COLON_PAREN_REMOVABLE = '(?:[ \\t]*\\([ \\t]*(?:GRADE|overall)[ \\t]*\\))?';
const LINE_END = '(?:[ \\t]*[.。])?[ \\t]*$';
const TAIL_ANY = `(?:[ \\t]*\\([^()\\n]{0,80}\\)){0,2}${LINE_END}`;
const PAREN_LEVEL = `\\([ \\t]*(?:GRADE|(?:(?:${LOOSE_LABEL_EN}|${EN_LABEL_RE}|${TH_LABEL_RE})[ \\t]*[:：][ \\t]*)?(?:${LEVEL_VALUE}))[ \\t]*\\)`;
const TAIL_LEVEL = `(?:[ \\t]*${PAREN_LEVEL}){0,2}${LINE_END}`;
const COLON_SP = '[ \\t]*[:：][ \\t]*';
const looseRe = (labelEn, labelTh, preParen, tail) => [
  new RegExp(`^(?:${labelEn}|${labelTh})${preParen}${COLON_SP}(?:${LEVEL_VALUE}|${GRADE_TOKEN})${tail}`, 'i'),
  new RegExp(`^${EVIDENCE_EN_LABEL_SHORT}${COLON_SP}${LEVEL_VALUE}${tail}`, 'i'),   // bare "Evidence:": levels only
];
const LOOSE_DETECT = looseRe(LOOSE_LABEL_EN, LOOSE_LABEL_TH, PRE_COLON_PAREN, TAIL_ANY);
const LOOSE_REMOVABLE = looseRe(LOOSE_LABEL_EN, LOOSE_LABEL_TH_REMOVABLE, PRE_COLON_PAREN_REMOVABLE, TAIL_LEVEL);
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{20E3}]*[ \t]*)+/u;

// Decoration stripped for the loose tests, or null when the line can never be a statement.
function looseCore(line) {
  if (typeof line !== 'string' || line.length > EVIDENCE_LINE_MAX_CHARS || isNestedOrIndented(line)) return null;
  let t = line.replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ').replace(/\*\*|__/g, '').trim();
  if (t.startsWith('❓')) return null;
  // Decoration may stack in any order ("> - ### 📊 *…*"); strip it until nothing changes. Bounded: each
  // pass removes at least one character or stops, and a line is at most EVIDENCE_LINE_MAX_CHARS long.
  for (let pass = 0, prev = null; pass < 8 && t !== prev; pass++) {
    prev = t;
    t = t.replace(/^(?:>[ \t]*)+/, '').replace(/^#{1,6}[ \t]*/, '').replace(LIST_MARKER, '')
      .replace(LEADING_EMOJI, '').replace(/^[*_]+/, '').replace(/[*_]+([.。]?)[ \t]*$/, '$1').trim();
  }
  return t;
}

// A near-miss or a strict marker: an evidence label, a colon and a level, and nothing else (see above).
function isEvidenceStatementLine(line) {
  if (parseEvidenceLine(line)) return true;
  const t = looseCore(line);
  return t != null && (parseEvidenceLine(t) != null || LOOSE_DETECT.some((re) => re.test(t)));
}

// A statement the splice may delete: a strict marker, or a near-miss whose every trailing "(…)" is itself
// level-like. Never a line carrying a citation, a number or any other content after its level.
function isRemovableEvidenceStatement(line) {
  if (parseEvidenceLine(line)) return true;
  const t = looseCore(line);
  return t != null && (parseEvidenceLine(t) != null || LOOSE_REMOVABLE.some((re) => re.test(t)));
}

// The level(s) a near-miss states, normalised: a level key where there is one ('high', …), else the
// level word or grade token in lower case ('very low', 'สูงมาก', 'b-r'). Used only to tell whether the
// near-misses a splice would remove AGREE — several that differ ("- Evidence level: high" under option 1,
// "- Evidence level: moderate" under option 2) are per-option grades, i.e. content.
const LEVEL_WORD_G = new RegExp(`(?<![A-Za-z\\u0E00-\\u0E7F])${ONE_LEVEL}`, 'gi');
const GRADE_AFTER_COLON = new RegExp(`[:：][ \\t]*(${GRADE_TOKEN})`, 'i');
function statedLevels(line) {
  const t = looseCore(line);
  if (t == null) return [];
  const strict = parseEvidenceLine(t);
  if (strict) return [strict];
  const colon = t.search(/[:：]/);
  if (colon < 0) return [];
  const words = t.slice(colon + 1).match(LEVEL_WORD_G);
  if (words) {
    return words.map((w) => {
      const n = w.toLowerCase().replace(/[ \t-]+/g, ' ');
      return EVIDENCE_BY_TH.get(w) ?? EVIDENCE_BY_EN.get(n) ?? n;
    });
  }
  const g = GRADE_AFTER_COLON.exec(t);
  return g ? [g[1].toLowerCase()] : [];
}

// Line indices (outside fences) of every evidence statement: strict markers and near-misses alike.
function findEvidenceStatements(content) {
  return linesOutsideFences(content).filter(({ line }) => isEvidenceStatementLine(line)).map(({ i }) => i);
}

// SPLICE, DON'T ADOPT. The chat route's marker-only retry (EVIDENCE_RETRY_PROMPT.only) asks for the one
// line alone; this takes the level from that answer and writes the CANONICAL line for it into the FIRST
// reply, which already passed every other check and which, on a streamed turn, the physician has
// already been reading. Nothing else in `retryText` is used, so a rewrite can never drop an artifact or
// reword prose behind the physician's back. (placeEvidenceLine below reuses it, with the reply's own
// level, to move a misplaced marker without any model call.)
//   - `retryText` must hold exactly ONE marker line (outside any fence) with a consistent level; else null.
//   - Every evidence statement the first reply already has outside a fence is removed first: strict
//     markers (two of them, or a self-contradicting one) AND near-misses (isEvidenceStatementLine). So the
//     result holds exactly ONE evidence statement outside fences — checked on the way out, not assumed.
//     If any of them carries more than a level (isRemovableEvidenceStatement: a citation, a trial size, a
//     population or outcome qualifier, any content), or the near-misses among them state different
//     levels (per-option grades), NOTHING is removed and the result is null. Lines inside a fence are content and are
//     never touched; nor are nested list items or indented blocks. Blank lines a removal exposes at the
//     end (or the start) of the reply go with it.
//   - Placement is the prompt's, after a BLANK line (markdown's paragraph break, without which marked /
//     ReactMarkdown merge the line into the paragraph, list item or table above it): natural mode ->
//     appended as the last line, so with nothing removed the result is a pure append of the first reply;
//     examiner mode -> inserted directly above the LAST ❓ line, so the ❓ stays last (appended if there is
//     none).
//   - On the way out the result must read back as exactly that level, hold one evidence statement, keep a
//     citation if the first reply had one (removing a near-miss such as "Evidence: high (BTS, 2019)" must
//     not take the reply's only citation with it), and keep the same ❓ question. Otherwise null.
// Returns { text, level } or null. On null the caller keeps the first reply unchanged.
function spliceEvidenceLine(firstText, retryText, { socratic = false } = {}) {
  const found = findEvidenceMarkers(retryText);
  if (found.length !== 1 || found[0].level === 'conflict') return null;
  const { level } = found[0];
  const line = evidenceLineFor(level);
  const first = String(firstText ?? '');
  const firstLines = first.split('\n');
  const staleAt = findEvidenceStatements(first);
  // Everything removed must be a bare evidence statement; one that carries content refuses the whole splice.
  if (staleAt.some((i) => !isRemovableEvidenceStatement(firstLines[i]))) return null;
  // Near-misses that state DIFFERENT levels grade different options or outcomes: content, refused whole.
  // (Strict markers are not counted: two of them that disagree are the ambiguity the retry exists to fix.)
  const nearMissLevels = new Set(staleAt.filter((i) => !parseEvidenceLine(firstLines[i])).flatMap((i) => statedLevels(firstLines[i])));
  if (nearMissLevels.size > 1) return null;
  const stale = new Set(staleAt);
  const lines = firstLines.filter((_, i) => !stale.has(i));
  // A removed line leaves the blank line that preceded (or followed) it. At the end that would leave the
  // reply ending in "\n" after the ❓ — and the transcript views lift the question with /\n❓[^\n]*$/,
  // which then misses it and the ❓ shows twice — so blank lines the removal exposed at either end go.
  if (!first.endsWith('\n')) while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (firstLines[0].trim() !== '') while (lines.length && lines[0].trim() === '') lines.shift();
  let text = null;
  if (socratic) {
    let q = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim().startsWith('❓')) { q = i; break; }
    if (q >= 0) {
      const blankAbove = q === 0 || lines[q - 1].trim() === '';
      lines.splice(q, 0, ...(blankAbove ? [line] : ['', line]));
      text = lines.join('\n');
    }
  }
  if (text == null) {
    const base = lines.join('\n');
    text = base === '' ? line : base + (base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n') + line;
  }
  if (extractEvidenceLevel(text) !== level || findEvidenceStatements(text).length !== 1) return null;
  if (hasCitation(first) && !hasCitation(text)) return null;
  if (extractSocraticQuestion(first) !== extractSocraticQuestion(text)) return null;
  return { text, level };
}

// Is the reply's ONE marker where the prompt puts it? natural (or examiner with no ❓): nothing but blank
// lines after it. examiner with a ❓: exactly one non-blank line after it, and that line is the ❓.
// Exported so the quality harness's placement check is this same definition.
function evidenceMarkerPlaced(text, { socratic = false } = {}) {
  const markers = findEvidenceMarkers(text);
  if (markers.length !== 1 || markers[0].level === 'conflict') return false;
  const after = String(text ?? '').split('\n').slice(markers[0].line + 1).map((l) => l.trim()).filter(Boolean);
  if (socratic && extractSocraticQuestion(String(text ?? '')) != null) return after.length === 1 && after[0].startsWith('❓');
  return after.length === 0;
}

// A reply that carries exactly one VALID marker in the wrong place (e.g. examiner: after the ❓, which
// also breaks physician-ui's question display), or next to a near-miss evidence statement, is put right
// WITHOUT a model call: the same splice, fed the reply's own level. Returns the new text, or null when
// nothing needs moving (or the splice's own checks refuse, in which case the reply stands as it is).
function placeEvidenceLine(text, { socratic = false } = {}) {
  const level = extractEvidenceLevel(text);
  if (!level) return null;
  if (evidenceMarkerPlaced(text, { socratic }) && findEvidenceStatements(text).length === 1) return null;
  const fixed = spliceEvidenceLine(text, evidenceLineFor(level), { socratic });
  return fixed && fixed.text !== text ? fixed.text : null;
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
  isEvidenceStatementLine, isRemovableEvidenceStatement, findEvidenceStatements, evidenceMarkerPlaced, placeEvidenceLine,
  thaiShare, isLanguageMismatch, isThaiMessage, stripNonProse, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
  MAX_PROSE_CHARS, MESSAGE_SAMPLE_CHARS,
};
