'use strict';

// The fast/deep chat router (CCME architecture mapping §2.1, docs/ARCHITECTURE-MAPPING-CCME.md).
//
// A PURE, DETERMINISTIC function of the turn: no model call, no clock, no randomness, no I/O after
// load. It decides whether a chat turn is answered with the tutor model's thinking OFF (fast: TTFT
// ~0.6 s on the CCME tutor) or ON (deep: slower, for the question classes where reasoning is worth the
// wait). routes/chat.js applies the decision only when the backend forwards `router_enabled` (app
// setting chat_router_enabled, default 0) AND the chat provider honours `thinking`
// (services/ai.js providerSupportsThinking). Otherwise nothing here changes what is sent.
//
// PRE-REGISTERED. ROUTER_VERSION names the rules: THIS FILE together with lib/router-keywords.json.
// ROUTER_RULES_SHA256 is computed at load over both — this file's text, a NUL byte, then the keyword
// file's text, line endings normalised (CRLF -> LF) so a CRLF checkout does not read as an edit — and
// tests/router.test.js pins it next to the version. Any edit to either file, a comment included, that
// does not also bump the version (and add its pin) fails CI. A routed arm measured under one version
// (docs/QUALITY-GATES.md, "Before chat_router_enabled is switched on") says nothing about another.
// Every routed turn carries ROUTER_LABEL — 'router-v1+<first 12 hex of ROUTER_RULES_SHA256>' — as its
// middleware_flags.router_version, so a stored turn names the exact rules that routed it.
//
// PII. It runs on the DE-IDENTIFIED message (chat.js passes `cleanMessage`, the very string the model
// receives), and it emits nothing derived from the text: `tier` and `reason` come from fixed sets
// (TIERS, REASONS), `version` is a constant. A masked identifier can never satisfy a keyword, because
// the mask replaced it before the router ran.
//
// RULES, in priority order (the first that applies decides):
//   1. rescuing           → fast  'rescue'   A rescue turn asks 1-2 questions and must not answer; it
//                                            has nothing to reason towards, and it is never streamed.
//   2. sticky             → deep  'sticky'   The session has already gone deep (the backend latches
//                                            ples.deep_mode_at and forwards `deep_mode`). One session
//                                            does not flip between modes turn by turn.
//   3. a keyword match    → deep  <category> The first category, in file order, with a match:
//                                            dosing, interaction, pregnancy, paediatric, differential,
//                                            explicit (a request for depth).
//   4. otherwise          → fast  'default'
//
// `historyLength` and `socratic` are accepted for later versions and IGNORED by router-v1: a rule that
// reads them is a new version, measured afresh. v1 also reads only the CURRENT message, never the chief
// complaint or the history: a pregnancy mentioned at session start does not make a later "which
// antibiotic?" deep on its own (the sticky latch covers the session once any turn has gone deep).
//
// MATCHING (lib/router-keywords.json):
//   * the text is NFC-normalised, lower-cased, stripped of zero-width characters (U+200B-U+200D,
//     U+FEFF, which some Thai editors insert as word-break hints) and its whitespace runs collapsed;
//   * `en` terms match on Latin-letter boundaries: not preceded or followed by a Latin letter, so "mg"
//     matches "500mg", "mg/kg" and "ให้ 500mgวันละ" but not "amgen", and "kid" never matches "kidney".
//     Words in a term are separated by single spaces; a trailing `*` on a word means "any further Latin
//     letters" (pregnan* = pregnant, pregnancy);
//   * `th` terms are plain substrings: Thai is written without spaces, so there is no boundary to test;
//   * `ignore` phrases are found first, with the same rules, and a keyword occurrence that overlaps an
//     ignored span does not count. They are the false-positive guards: lab units ("mg/dL"), Child-Pugh,
//     and adult-history phrases ("since childhood").
//
// KEYWORD CHOICES — the false-positive reasoning, so the next version starts from it:
//   * bare "kg" is NOT a dosing term: a weight is in most case vignettes ("70 kg man with CAP"). "mg",
//     "mcg", "ml/kg", "units/kg" and "per kg" are. "mg" as a LAB unit is ignored (mg/dL, mg/L, mg/mmol,
//     mg/g, mg%); serum Mg (magnesium) reads as "mg" after lower-casing — "serum mg" is ignored, a bare
//     "Mg 1.4" still routes deep, which costs latency, not safety.
//   * bare "เด็ก" (child) IS a term, because it is the ordinary word for a paediatric patient or
//     population ("ในเด็ก", "ผู้ป่วยเด็ก", and "เด็ก[AGE-1]" once the PII filter has masked an age).
//     Its adult-history uses — ตั้งแต่เด็ก / ตอนเด็ก / ตอนเป็นเด็ก / สมัยเด็ก / ตั้งแต่วัยเด็ก ("since /
//     as a child") — are ignored, as are the same forms of วัยรุ่น. English "child" matches only the
//     word itself ("childhood" does not, by the boundary rule) and Child-Pugh / child-bearing /
//     "as a child" are ignored.
//   * "ท้อง" (belly) is NOT a pregnancy term: ปวดท้อง (abdominal pain) is everywhere. Only ตั้งท้อง and
//     แพ้ท้อง are; "ครรภ์" is, because every word containing it is obstetric.
//   * "แยกโรค" alone is NOT a differential term: ห้องแยกโรค is an isolation room. "วินิจฉัยแยก",
//     "แยกโรคจาก" and "แยกจากโรค" are. English "differential" alone is not (a CBC differential).
//   * "lactat*" is NOT a pregnancy term (serum lactate): "lactation" and "lactating" are.
//   * "อย่างละเอียด" alone is NOT an explicit-depth term ("ตรวจร่างกายอย่างละเอียด" is case narrative);
//     the request forms are (อธิบายอย่างละเอียด, ขอรายละเอียด, …). "comprehensive" is not (comprehensive
//     metabolic panel).
// Known limits of v1: NFC does not reorder Thai vowel/tone marks typed in a non-canonical order; and
// a false positive is the cheap direction by design (a slower, reasoned reply), a false negative the
// one the measurement watches.
//
// PACKAGE-FREE: it requires nothing but Node built-ins and its keyword file, so the quality harness
// (scripts/quality/request.mjs) imports this very module — one definition of the router, as for the
// prompts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Read as TEXT and parsed here (not require()d), so the hashes below are of exactly the bytes the rules
// were compiled from. Line endings are normalised before hashing.
const lf = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  parts.forEach((p, i) => { if (i) h.update('\0'); h.update(p, 'utf8'); });
  return h.digest('hex');
};
const RULES_FILE = __filename;
const KEYWORDS_FILE = path.join(__dirname, '..', 'lib', 'router-keywords.json');
const KEYWORDS_TEXT = fs.readFileSync(KEYWORDS_FILE, 'utf8');
const KEYWORDS = JSON.parse(KEYWORDS_TEXT);
const ROUTER_KEYWORDS_SHA256 = sha256(lf(KEYWORDS_TEXT));
// This file + the keyword file: the WHOLE rule set (see the header). What the version label carries.
const ROUTER_RULES_SHA256 = sha256(lf(fs.readFileSync(RULES_FILE, 'utf8')), lf(KEYWORDS_TEXT));

const ROUTER_VERSION = 'router-v1';
const ROUTER_LABEL = `${ROUTER_VERSION}+${ROUTER_RULES_SHA256.slice(0, 12)}`;
const TIERS = Object.freeze(['fast', 'deep']);

const LATIN = '\\p{Script=Latin}';
const ZERO_WIDTH = /[​-‍﻿]/g;

function normalise(text) {
  return String(text ?? '').normalize('NFC').replace(ZERO_WIDTH, '').toLowerCase().replace(/\s+/g, ' ');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One English term -> a global regex on Latin-letter boundaries. Validated at load: a term with a
// character outside this set is a typo in the data file, and a typo must fail loudly at boot, not
// quietly never match.
const EN_TERM = /^[a-z0-9][a-z0-9 \-/'.%+*]*$/;
function enPattern(term) {
  if (!EN_TERM.test(term) || /\*\S/.test(term) || /\s{2,}/.test(term)) {
    throw new Error(`router-keywords.json: invalid English term ${JSON.stringify(term)}`);
  }
  const body = term.split(' ').map((w) => (w.endsWith('*') ? `${escapeRe(w.slice(0, -1))}${LATIN}*` : escapeRe(w))).join(' ');
  return new RegExp(`(?<!${LATIN})${body}(?!${LATIN})`, 'gu');
}

const THAI = /[฀-๿]/;
function thTerm(term) {
  if (!THAI.test(term) || term.includes('*') || term !== term.trim()) {
    throw new Error(`router-keywords.json: invalid Thai term ${JSON.stringify(term)}`);
  }
  return term;
}

// Compile once, at load. Every term is normalised exactly as the text will be.
function compile(list, kind) {
  return (list || []).map((raw) => {
    const t = normalise(raw).trim();
    return kind === 'en' ? { kind, re: enPattern(t) } : { kind, s: thTerm(t) };
  });
}

const IGNORE = [...compile(KEYWORDS.ignore?.en, 'en'), ...compile(KEYWORDS.ignore?.th, 'th')];
const CATEGORIES = KEYWORDS.categories.map((c) => {
  if (!c || typeof c.name !== 'string' || !c.name) throw new Error('router-keywords.json: a category has no name');
  return { name: c.name, terms: [...compile(c.en, 'en'), ...compile(c.th, 'th')] };
});
if (new Set(CATEGORIES.map((c) => c.name)).size !== CATEGORIES.length) {
  throw new Error('router-keywords.json: duplicate category name');
}

const CATEGORY_NAMES = Object.freeze(CATEGORIES.map((c) => c.name));
const REASONS = Object.freeze(['rescue', 'sticky', ...CATEGORY_NAMES, 'default']);

// Every [start, end) occurrence of one compiled term in normalised text.
function spans(term, text) {
  const out = [];
  if (term.kind === 'en') {
    term.re.lastIndex = 0;
    for (const m of text.matchAll(term.re)) out.push([m.index, m.index + m[0].length]);
  } else {
    for (let i = text.indexOf(term.s); i !== -1; i = text.indexOf(term.s, i + 1)) out.push([i, i + term.s.length]);
  }
  return out;
}

const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

/** The first category (file order) with an occurrence outside every ignored span, or null. */
function matchCategory(message) {
  const text = normalise(message);
  if (!text.trim()) return null;
  const ignored = IGNORE.flatMap((t) => spans(t, text));
  for (const c of CATEGORIES) {
    for (const term of c.terms) {
      if (spans(term, text).some((s) => !ignored.some((g) => overlaps(s, g)))) return c.name;
    }
  }
  return null;
}

/**
 * Route one chat turn. Pure and deterministic: the same inputs always give the same answer.
 * @param {object}  turn
 * @param {string}  turn.message        the DE-IDENTIFIED physician message (chat.js cleanMessage)
 * @param {number}  [turn.historyLength] unused by router-v1 (accepted for later versions)
 * @param {boolean} [turn.socratic]      unused by router-v1 (accepted for later versions)
 * @param {boolean} [turn.rescuing]      this turn runs under the rescue prompt
 * @param {boolean} [turn.sticky]        the session has already gone deep (ples.deep_mode_at)
 * @returns {{ tier: 'fast'|'deep', reason: string, version: string }}  version = ROUTER_LABEL
 */
function routeTurn({ message, historyLength, socratic, rescuing, sticky } = {}) {
  if (rescuing === true) return { tier: 'fast', reason: 'rescue', version: ROUTER_LABEL };
  if (sticky === true) return { tier: 'deep', reason: 'sticky', version: ROUTER_LABEL };
  const category = matchCategory(message);
  if (category) return { tier: 'deep', reason: category, version: ROUTER_LABEL };
  return { tier: 'fast', reason: 'default', version: ROUTER_LABEL };
}

module.exports = {
  routeTurn, matchCategory, normalise,
  ROUTER_VERSION, ROUTER_LABEL, ROUTER_RULES_SHA256, ROUTER_KEYWORDS_SHA256, RULES_FILE, KEYWORDS_FILE,
  TIERS, REASONS, CATEGORY_NAMES,
};
