function hasCitation(content) {
  return /\([^)]+,\s*\d{4}[^)]*\)/.test(content);
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
  const refs = [];
  const pattern = /\(([^)]+,\s*\d{4}[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.push({ source: match[1].trim(), title: match[1].split(',')[0].trim() });
  }
  return refs;
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
function stripNonProse(text) {
  return String(text ?? '')
    .replace(/^:::artifact\{[^}\n]*\}[^\n]*(?:\n[\s\S]*?^:::[ \t]*$|[\s\S]*$)/gm, ' ')
    .replace(/^[ \t]*(?:#{1,6}[ \t]*)?\**(?:References?|Bibliography|เอกสารอ้างอิง|บรรณานุกรม)\**[ \t]*:?[ \t]*\**[ \t]*(?:\n[\s\S]*)?$/im, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\([^)]+,\s*\d{4}[^)]*\)/g, ' ');
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
  thaiShare, isLanguageMismatch, stripNonProse, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
};
