// The span rules that screen booth free text on top of rimpl's write-time pii-filter: a long number (a phone or
// an id, dotted, spaced or in Thai digits), an email, an honorific or labelled name. One copy, here, because the
// backend deploys alone: the auditor read (services/booth-dialogue.js studyTranscript), the open dataset's scanPii
// (scripts/booth/open-dataset.mjs) and the manuals screenshot gate (scripts/manuals/lib/pii-gate.mjs) all read it.

/** Thai digits ๐-๙ defeat every \d predicate, so normalise before any numeric rule runs. */
function ascii(s) {
  return String(s).replace(/[๐-๙]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0e50 + 48));
}

// Honorific + a Thai given name. The honorifics are the ones the product's own forms and the rimpl
// title list use; a name behind one of these is never a clinical noun.
const TH_HONORIFIC_NAME =
  /(?:นายแพทย์|แพทย์หญิง|ศาสตราจารย์|รองศาสตราจารย์|ผู้ช่วยศาสตราจารย์|นพ\.|พญ\.|ศ\.|รศ\.|ผศ\.|ดร\.|นางสาว|นาง|นาย)\s*([ก-ฮ][ก-ฮะ-๎]{2,})/g;

// An explicitly labelled name field — what /identity renders back from full_name_th / full_name_en.
const TH_LABELLED_NAME = /(?:ชื่อ-?นามสกุล|ชื่อจริง|นามสกุล|full[_\s]?name)\s*[:：]?\s*([^\s,;)]{2,})/gi;

const LONG_NUMBER = /(?<![0-9])[0-9](?:[-.\s]?[0-9]){5,}(?![0-9])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STARTS_WITH_PLACEHOLDER = /^\[[A-Z]+-\d+\]/;
// The name rules, widened to the words after the name, so a surname is part of the span.
const HONORIFIC_SPAN = new RegExp(`${TH_HONORIFIC_NAME.source}(?:[ \\t]+[ก-ฮเ-ไ][ก-ฮะ-๎]+)?`, 'g');
const LABELLED_SPAN = new RegExp(`${TH_LABELLED_NAME.source}(?:[ \\t]+[^\\s,;)]+){0,2}`, 'gi');

/** Every rule reads Thai-digit-normalised text (ascii). */
const SPAN_RULES = Object.freeze([
  { rule: 'long-number', re: LONG_NUMBER },
  { rule: 'email', re: EMAIL },
  { rule: 'honorific-name', re: HONORIFIC_SPAN },
  { rule: 'labelled-name', re: LABELLED_SPAN, keep: (m) => !STARTS_WITH_PLACEHOLDER.test(m[1]) },
]);

/** @param {string} flat  text already passed through ascii
 *  @returns {{ rule: string, match: string, index: number }[]} */
const spanMatches = (flat) => SPAN_RULES.flatMap(({ rule, re, keep = () => true }) =>
  [...flat.matchAll(re)].filter(keep).map((m) => ({ rule, match: m[0], index: m.index })));

module.exports = {
  ascii, TH_HONORIFIC_NAME, TH_LABELLED_NAME, STARTS_WITH_PLACEHOLDER, HONORIFIC_SPAN, LABELLED_SPAN, SPAN_RULES, spanMatches,
};
