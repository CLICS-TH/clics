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
  thaiShare, isLanguageMismatch, isThaiMessage, stripNonProse, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
  MAX_PROSE_CHARS, MESSAGE_SAMPLE_CHARS,
};
