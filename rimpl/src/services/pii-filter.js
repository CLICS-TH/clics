'use strict';

// ---------------------------------------------------------------------------
// On-premise de-identification (RIMPL layer).
//
// HARD RULE: PII must NEVER reach the cloud AI. stripPii() runs on every
// outbound cloud call. This is IN-TEXT masking only — it is intentionally NOT
// a persistent, reversible cross-session store. The reversible on-prem map is
// a separate track. Here we only need the masked text to (a) carry no PII and
// (b) keep clinical meaning + coreference inside a single outbound call.
//
// Coreference: the same surface form within one call resolves to the SAME
// token (e.g. every "นายสมชาย" -> [NAME-1]); a different name -> [NAME-2]. This
// is achieved with a per-call registry threaded through every message by
// stripHistoryPii, so a name introduced in turn 1 keeps its token in turn 9.
//
// Do NOT over-mask clinical content: vitals (BP 120/80, O2 sat 98%), lab
// values, ratios, drug names and common medical abbreviations must SURVIVE.
// The ordering of the passes below is load-bearing — structured identifiers
// (phone/ID/email) are consumed before looser numeric/age rules can touch
// them, and clinical "shields" are reserved before name rules run.
// ---------------------------------------------------------------------------

// A per-call registry assigns stable, category-scoped tokens: the first
// distinct value in a category gets index 1, the next distinct value index 2,
// and identical values reuse their token. Reset per outbound call.
//
// For NAMEs it also keeps an alias index so that a multi-token name registers
// its individual parts (given / surname) against the SAME token. That lets a
// later bare given-name occurrence ("สมชายบอกว่า...") resolve to the token the
// full name "นายสมชาย ใจดี" already got — preserving coreference across turns
// even when the surface form differs.
const { TH_GIVEN_NAMES, TH_SURNAMES, TH_SURNAME_MORPHEMES } = require('./pii-names.th');
const { TH_CLINICAL_CONTINUATIONS } = require('./pii-clinical-words.th');

function makeRegistry() {
  const counters = Object.create(null); // category -> next index
  const seen = Object.create(null);     // category -> { surfaceForm -> token }
  const aliases = Object.create(null);  // category -> { alias -> token }
  const wordAliases = Object.create(null); // category -> { whole-word-only alias -> token }

  function ensure(category) {
    if (!seen[category]) {
      seen[category] = Object.create(null);
      aliases[category] = Object.create(null);
      wordAliases[category] = Object.create(null);
      counters[category] = 0;
    }
  }

  function token(category, surfaceForm) {
    ensure(category);
    const key = surfaceForm.trim();
    if (seen[category][key] === undefined) {
      // Reuse a token already bound to one of this surface form's parts.
      const existing = aliases[category][key] ?? wordAliases[category][key];
      if (existing !== undefined) {
        seen[category][key] = existing;
      } else {
        counters[category] += 1;
        seen[category][key] = `[${category}-${counters[category]}]`;
      }
    }
    return seen[category][key];
  }

  // Bind extra surface forms (e.g. each word of a full name) to a token so a
  // later standalone occurrence reuses it. Never overwrites an existing alias.
  function alias(category, surfaceForm, tok) {
    ensure(category);
    const key = surfaceForm.trim();
    if (key && aliases[category][key] === undefined) {
      aliases[category][key] = tok;
    }
  }

  // Like alias(), for a bare surname taken next to a given name: the bare-name pass folds it in as a whole
  // word, and inside a glued Thai run only when that run is not wholly clinical vocabulary ("ญาติของใจดีโทรมา"
  // is masked, "จิตใจดีขึ้น" = จิตใจ + ดีขึ้น is not). A surface already bound as an ordinary alias keeps that
  // binding. The surface also enters `seen`, so the Tier-1 reverse map (entries()) can restore
  // "[NAME-1] [NAME-1]" to the full name, not the given name twice.
  function wordAlias(category, surfaceForm, tok) {
    ensure(category);
    const key = surfaceForm.trim();
    if (key && aliases[category][key] === undefined && wordAliases[category][key] === undefined) {
      wordAliases[category][key] = tok;
      if (seen[category][key] === undefined) seen[category][key] = tok;
    }
  }

  // Snapshot of all NAME aliases currently known (used to catch bare names).
  function knownAliases(category) {
    ensure(category);
    return aliases[category];
  }
  function knownWordAliases(category) {
    ensure(category);
    return wordAliases[category];
  }

  // Dump the reverse map (token -> the raw surface form that produced it) for the on-prem reversible
  // PII store (Tier-1 audit). `seen` holds exactly the distinct values that were masked. The `value`s
  // ARE raw PII, so the caller MUST keep this on-prem and encrypted at rest — it never goes to cloud.
  function entries() {
    const out = [];
    for (const category of Object.keys(seen)) {
      for (const value of Object.keys(seen[category])) {
        out.push({ token: seen[category][value], category, value });
      }
    }
    return out;
  }

  token.alias = alias;
  token.wordAlias = wordAlias;
  token.knownAliases = knownAliases;
  token.knownWordAliases = knownWordAliases;
  // How many surface forms the registry knows: primeRegistry stops when a round adds none.
  function size() {
    let n = 0;
    for (const m of [seen, aliases, wordAliases]) for (const c of Object.keys(m)) n += Object.keys(m[c]).length;
    return n;
  }

  token.entries = entries;
  token.size = size;
  return token;
}

// Thai honorific titles that lead a personal name.
// นพ. = physician (male), พญ. = physician (female), ด.ช./ด.ญ. = boy/girl child (abbreviated), and the
// SPELLED-OUT pediatric forms เด็กชาย/เด็กหญิง/เด็กทารก — the common written form for a named child
// patient (e.g. "เด็กชายสมชาย"), which the abbreviations alone missed → the name leaked to the cloud.
const TH_TITLES = ['นพ\\.', 'พญ\\.', 'ด\\.ช\\.', 'ด\\.ญ\\.', 'เด็กชาย', 'เด็กหญิง', 'เด็กทารก', 'นางสาว', 'นาง', 'นาย', 'คุณ'];
// English honorifics. Order matters only for the alternation; \. is optional.
const EN_TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'];

// Strip a leading honorific from a patient_ref token (e.g. "นายสมชาย" -> "สมชาย", "Mr Smith" tokens).
// Reuses the SAME title lists as the masking rules so the two never drift.
const HONORIFIC_STRIP_RE = new RegExp(`^(?:${TH_TITLES.join('|')}|(?:${EN_TITLES.join('|')})\\.?)`, 'i');

// Derive deterministic scrub hints from the physician's structured patient identifier
// (ple_patient_refs.patient_ref), passed in by the backend on-prem. Split on whitespace, drop a
// leading honorific, then keep only name-ish tokens: >= 3 Thai letters OR a Capitalised Latin word.
// Pure digits / labels (HN, MRN) / punctuation / MED_SHIELD are dropped so we never scrub them as a
// "name". The surviving strings are masked verbatim (even mid-sentence) by the intake-hint pass.
function deriveHintTokens(patientRef) {
  if (typeof patientRef !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const raw of patientRef.replace(ZERO_WIDTH_RE, '').split(/\s+/)) {
    const stripped = raw.replace(HONORIFIC_STRIP_RE, '').trim();
    if (!stripped || MED_SHIELD.has(stripped)) continue;
    const thaiLen = (stripped.match(/[ก-ฮะ-๎]/g) || []).length;
    const isLatinName = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/.test(stripped);
    if ((thaiLen >= 3 || isLatinName) && !seen.has(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }
  return out;
}

// A Thai name token: a run of Thai letters (no spaces — Thai names are written
// without internal spaces; a surname is a separate token after a space).
const TH_NAME = '[\\u0E01-\\u0E2E\\u0E30-\\u0E4E]+';
// An English name token: Capitalised word, optionally hyphenated (e.g. Smith-Jones).
const EN_NAME = "[A-Z][a-z]+(?:-[A-Z][a-z]+)?";

// Common ALL-CAPS / capitalised medical abbreviations that look like a name
// token but must survive (they can follow "Dr" only by coincidence, but more
// importantly must never themselves be masked as standalone names).
const MED_SHIELD = new Set([
  'BP', 'HR', 'RR', 'SpO2', 'SpO', 'O2', 'CO2', 'GCS', 'BMI', 'ECG', 'EKG',
  'CXR', 'CT', 'MRI', 'CBC', 'BUN', 'Cr', 'Na', 'K', 'Cl', 'HCO3', 'Hb',
  'Hct', 'WBC', 'INR', 'PT', 'PTT', 'ABG', 'LFT', 'ICU', 'ER', 'OPD', 'IPD',
  'IV', 'IM', 'PO', 'NPO', 'PRN', 'STAT', 'COPD', 'CHF', 'MI', 'ACS', 'CKD',
  'DM', 'HT', 'HTN', 'TB', 'UTI', 'DVT', 'PE', 'CVA', 'SOB', 'NAD',
]);

// Build the honorific-led name regex.
//
// Thai: title then a SINGLE following name token (the given name). This regex
// does not grab the space-separated token after it: Thai compounds words without
// spaces, so that token is just as likely a clinical phrase ("ปวดท้อง" = abdominal
// pain, "ตรวจคนไข้" = examined the patient) as a surname. The bare surname is
// taken afterwards by the 'th-given-surname' pass (applyGivenSurnamePass), which
// folds it into the given name's [NAME-n] unless it opens a clinical / function
// phrase (#224: "นายสมชาย ใจดี" sent ใจดี to the model in clear).
const TH_NAME_RE = new RegExp(
  `(${TH_TITLES.join('|')})\\s*(${TH_NAME})`,
  'g'
);
// English: spacing + capitalisation make a 2-token (first + last) name safe.
const EN_NAME_RE = new RegExp(
  `\\b(${EN_TITLES.join('|')})\\.?\\s+(${EN_NAME}(?:\\s+${EN_NAME})?)`,
  'g'
);

// Clinical-lead shield for a bare (un-keyworded) surname token after a labelled
// given name. Thai compounds words without spaces, so the space-separated token
// AFTER a given name is sometimes a surname and sometimes the start of a verb /
// symptom phrase ("มาด้วย..." = presented with, "ปวด..." = pain, "อาการ..." =
// symptom, "มี..." = has, "อายุ..." = age). If the candidate surname BEGINS with
// any of these clinical/grammatical leads we do NOT treat it as a surname — that
// keeps clinical phrases intact at the cost of leaving a bare surname only in the
// rare case a real surname literally starts with one of these syllables.
const TH_CLINICAL_LEADS = [
  'มา', 'ปวด', 'อาการ', 'มี', 'เป็น', 'ไม่', 'อายุ', 'ตรวจ', 'ได้', 'ที่',
  'และ', 'หรือ', 'แล้ว', 'จาก', 'ด้วย', 'นัด', 'รักษา', 'ป่วย', 'เจ็บ',
  'บวม', 'ไข้', 'ไอ', 'หอบ', 'เหนื่อย', 'คลื่น', 'อาเจียน', 'ถ่าย', 'ท้อง',
];
function startsWithClinicalLead(token) {
  return TH_CLINICAL_LEADS.some((lead) => token.startsWith(lead));
}

// ---------------------------------------------------------------------------
// Clinical FALSE-POSITIVE shields for the คุณ / ชื่อ anchors.
//
// Thai has no word spaces, so an anchor (คุณ, ชื่อ) is followed by a glued run
// that is sometimes a name and sometimes ordinary prose: ขอบคุณครับ ("thank
// you"), คุณหมอ (a form of address), คุณภาพ ("quality"), ชื่อยา ("drug name").
//
// FAIL-CLOSED TOKENISER (scanRun): the WHOLE glued run is split into words from
// closed lists. The run is let through only if every character is accounted
// for. At the first unknown segment, everything from the last ANCHOR to the end
// of the run is masked as one name. An anchor is a point that cannot sit inside
// a name: the end of a role / kin word at the head of the run (คุณหมอ|สมชาย) or
// of a complete compound (คุณภาพชีวิต|…). With no anchor the whole run is masked,
// exactly as on master. Plain list words (particles, function words) are NOT
// anchors, because names begin with them: ของขวัญ, คิดถึง, กำลังใจ, คะนอง,
// ภาพร. So "คุณของขวัญ" is masked whole and "คุณแม่ของสมศรี" → "คุณแม่[NAME-n]".
//
// The one way a name can still pass is if it is written ENTIRELY of list words.
// Keep every list free of words that complete a name with another list word:
// ใจ, ขวัญ, ถึง, ดี and มา / มี (มานี, มาลี, มีนา) are deliberately absent.
//
// A nested คุณ / ชื่อ inside the run is not tokenised: the scan stops there and
// the pass resumes at it (resumable replace, iterative, never recursive), so
// "ขอบคุณครับคุณสมศรี" still masks สมศรี and a 5000-char "คุณจะคุณจะ…" cannot
// blow the stack.
// ---------------------------------------------------------------------------

// Function words / verbs that follow the pronoun คุณ ("you") or a thing-label. None is a Thai given
// name on its own. NOT here on purpose — each is ALSO a given name or nickname, so "คุณ<word>" alone
// must stay masked: มา / มี (มานี, มาลี, มีนา), ต้อง (nickname), สามารถ and ช่วย (male given names;
// review of PR #114 — "คุณสามารถ อายุ 50 ปี" leaked). The cost is over-masking glued "คุณสามารถ…".
const TH_FUNCTION_WORDS = [
  'ที่', 'ว่า', 'คือ', 'ของ', 'บอก', 'แจ้ง', 'ให้', 'ได้', 'ไม่', 'ก็', 'จะ',
  'และ', 'หรือ', 'เป็น', 'สำหรับ', 'ล่วงหน้า', 'นี้', 'นั้น', 'อะไร', 'ซึ่ง', 'ถาม',
  'ตอบ', 'คิด', 'ตรวจ', 'ควร', 'เคย', 'อยาก', 'ลอง', 'ทราบ', 'รู้',
  'เห็น', 'พิจารณา', 'วินิจฉัย', 'สั่ง', 'กำลัง', 'เลือก', 'ใช้', 'ระบุ', 'อธิบาย', 'เชื่อ',
];
// Polite particles / closings (ขอบคุณครับ, ขอบคุณมากค่ะ). คะ / นะ / มาก can begin a name (คะนอง), which is
// why no list word is an anchor.
const TH_PARTICLES = ['ครับ', 'ค่ะ', 'คะ', 'คับ', 'จ้ะ', 'จ้า', 'นะ', 'มาก', 'ผม', 'ดิฉัน'];
// Clinical nouns that complete common clauses (คุณภาพชีวิตของผู้ป่วยดีขึ้น). Never part of a name.
const TH_CLINICAL_PROSE = ['ผู้ป่วย', 'คนไข้', 'อาการ', 'ดีขึ้น', 'แย่ลง'];
// Role / kinship forms of address (คุณหมอ, คุณแม่). They are ANCHORS only at the head of a คุณ run —
// a real name may follow (คุณหมอสมชาย → คุณหมอ[NAME-n]). Short kin words that begin given names
// (ตา → ตาล, อา → อารีย์ / อานนท์, น้า) are deliberately absent.
const TH_ADDRESS_TERMS = [
  'หมอ', 'พยาบาล', 'เภสัชกร', 'อาจารย์', 'แม่', 'พ่อ', 'ป้า', 'ลุง', 'ยาย', 'ปู่', 'ย่า', 'พี่', 'ญาติ',
];
// คุณ + one of these is ONE word that no given name begins with → an anchor:
// คุณค่า (value), คุณลักษณะ (attribute), คุณูปการ (contribution).
// Deliberately absent: คุณสมบัติ (สมบัติ is a given name, pii-names.th.js) and คุณประโยชน์ (ประโยชน์ is
// used as a given name too) — both stay masked.
const TH_KHUN_COMPOUND_ANCHORS = ['ค่า', 'ลักษณะ', 'ูปการ'];
// คุณภาพ ("quality") — but ภาพ also begins given names (ภาพร, ภาพิมล, ภาพพิมพ์), so ภาพ is an anchor only
// together with one of these continuations, each of which makes the compound unambiguous prose:
// คุณภาพชีวิต (quality of life), คุณภาพการนอน (sleep quality), คุณภาพการรักษา / การดูแล / การบริการ
// (quality of treatment / care / service). Bare "คุณภาพ" at the end of the run is the word itself.
const TH_KHUN_PHAP_CONTINUATIONS = ['ชีวิต', 'การนอน', 'การรักษา', 'การดูแล', 'การบริการ'];
// ชื่อ + one of these labels a THING (drug, disease, generic / trade name, organism, topic). Not an
// anchor either (ยา begins ยาใจ): "ชื่อยา…" survives only when the whole run tokenises.
const TH_LABEL_NON_NAME = ['ยา', 'โรค', 'สามัญ', 'การค้า', 'ทางการค้า', 'เชื้อ', 'วิทยาศาสตร์', 'เรื่อง'];

const TH_RUN_WORDS = [...TH_FUNCTION_WORDS, ...TH_PARTICLES, ...TH_CLINICAL_PROSE, ...TH_ADDRESS_TERMS];
const TH_LABEL_RUN_WORDS = [...TH_RUN_WORDS, ...TH_LABEL_NON_NAME];

// Longest entry of `list` that `s` contains at `pos`, or ''.
function wordAt(s, pos, list) {
  let best = '';
  for (const w of list) {
    if (w.length > best.length && s.startsWith(w, pos)) best = w;
  }
  return best;
}

// Tokenise `run` from `pos` (see the block comment). Returns one of
//   { action: 'survive' }           every character is a list word
//   { action: 'resume', at }        run[0, at) is list words and a nested anchor starts at `at`
//   { action: 'mask', at }          keep run[0, at), mask run[at..] as one name (at 0 = master behaviour)
function scanRun(run, pos, anchor, words, nestedAnchors) {
  while (pos < run.length) {
    if (wordAt(run, pos, nestedAnchors)) return { action: 'resume', at: pos };
    const w = wordAt(run, pos, words);
    if (!w) return { action: 'mask', at: anchor };
    pos += w.length;
  }
  return { action: 'survive' };
}

// The run after a คุณ title.
function scanKhunRun(run) {
  let pos = 0;
  if (run.startsWith('ภาพ')) {
    const cont = wordAt(run, 3, TH_KHUN_PHAP_CONTINUATIONS);
    if (cont) pos = 3 + cont.length;
    else if (run.length === 3) return { action: 'survive' };
    else if (run.startsWith('คุณ', 3)) return { action: 'resume', at: 3 };
    else return { action: 'mask', at: 0 }; // ภาพร, ภาพพิมพ์, ภาพิมล — a name, masked whole
  } else {
    pos = wordAt(run, 0, TH_KHUN_COMPOUND_ANCHORS).length;
  }
  // Role / kin words directly at the head are anchors (คุณหมอ, คุณพี่หมอ); after the head they are
  // ordinary list words.
  for (let a = wordAt(run, pos, TH_ADDRESS_TERMS); a; a = wordAt(run, pos, TH_ADDRESS_TERMS)) pos += a.length;
  return scanRun(run, pos, pos, TH_RUN_WORDS, ['คุณ']);
}

// The run after a ชื่อ label. null = it does not start with a thing-label (a person's name: master path).
function scanLabelRun(run) {
  const w = wordAt(run, 0, TH_LABEL_NON_NAME);
  if (!w) return null;
  return scanRun(run, w.length, 0, TH_LABEL_RUN_WORDS, ['ชื่อ', 'คุณ']);
}

// Longest glued run the shields will tokenise. Each resume (at a nested คุณ / ชื่อ) re-matches the rest
// of the run, so a run with n nested anchors costs O(n x run length): fine for real prose, quadratic for
// a hostile "คุณคุณคุณ…" (review of PR #114: 100k chars took 1.28 s). Longer runs skip the shields and
// take master's path — the whole run masked as one name: linear, and fail-closed. Real Thai clauses
// glued after คุณ / ชื่อ are far shorter; one that is not is simply over-masked as on master.
const SHIELD_MAX_RUN = 256;

// String#replace for a global regex, except the callback may consume only PART of a match by returning
// [replacement, consumedLength]; scanning then resumes right after the consumed part. Iterative — the
// shields above use it instead of re-scanning fragments recursively.
// `view`, when given, is a same-length copy of `text` the regex runs on; the cut is made in `text`.
function replaceResumable(text, re, fn, view = text) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); // exec must advance
  let out = '';
  let last = 0;
  let m;
  while ((m = rx.exec(view)) !== null) {
    const r = fn(m);
    const [rep, used] = Array.isArray(r) ? r : [r, m[0].length];
    out += text.slice(last, m.index) + rep;
    last = m.index + Math.max(1, used);
    rx.lastIndex = last;
  }
  return out + text.slice(last);
}

// Thai nickname field: "ชื่อเล่น X". MUST be matched before the plain "ชื่อ"
// rule (ชื่อ is a prefix of ชื่อเล่น) or the label gets mangled into "ชื่อ" and
// the nickname leaks. English "nickname X" is handled in the EN labelled rule.
const TH_NICKNAME_RE = new RegExp(
  `ชื่อเล่น\\s*(${TH_NAME})`,
  'g'
);
const EN_NICKNAME_RE = new RegExp(
  `\\bnickname\\s+(${EN_NAME})`,
  'gi'
);

// Labelled Thai name fields:
//   "ชื่อ X นามสกุล Y"   — explicit given / surname keywords
//   "ชื่อ X Y"           — given then a bare surname (no นามสกุล keyword)
//   "ชื่อ X"             — given alone
//   also matches a leading "ผู้ป่วยชื่อ" / "คนไข้ชื่อ" because the prefix word
//   ends right before ชื่อ; we only anchor on ชื่อ itself.
// The optional bare-surname group is kept out only when it is wholly clinical
// vocabulary (isClinicalRun). Surname token(s) fold into the same [NAME-n] referent.
// (?<!เ): the verb เชื่อ ("believe" — เชื่อว่า, ความเชื่อมั่น) CONTAINS ชื่อ. A leading
// vowel เ always belongs to the syllable it precedes, so "เชื่อ" can never be
// "เ" + the label ชื่อ — excluding it cannot hide a real label.
// The bare-surname group may not run THROUGH another ชื่อ: otherwise in
// "ชื่อยา… ผู้ป่วยชื่อ มานะ" it swallows the second label and leaves the real
// name (มานะ) outside the match, where nothing masks it.
const TH_NAME_NO_LABEL = '(?:(?!ชื่อ)[\\u0E01-\\u0E2E\\u0E30-\\u0E4E])+';
const TH_LABELLED_RE = new RegExp(
  `(?<!เ)ชื่อ\\s*(${TH_NAME})(?:\\s*นามสกุล\\s*(${TH_NAME})|\\s+(${TH_NAME_NO_LABEL}))?`,
  'g'
);

// Standalone labelled SURNAME: "นามสกุล Y" with no preceding "ชื่อ" in the same span (e.g.
// "คนไข้ นายวีระ นามสกุล ทองดี" — the given name is masked by the title rule, but the surname leaked
// because TH_LABELLED_RE anchors on ชื่อ). MUST run AFTER TH_LABELLED_RE so the combined
// "ชื่อ X นามสกุล Y" form is consumed first and this can't re-grab the keyword as a bare surname.
const TH_SURNAME_RE = new RegExp(`นามสกุล\\s*(${TH_NAME})`, 'g');

// LINE pass guard — see the LINE entry in PASSES. Thai label / explicit English
// marker → always an id. Bare "line <word>" → only when the word is id-shaped.
function lineIdGuard(m) {
  if (m.startsWith('ไลน์')) return true;
  if (/^line\s*(?:id\b|[:：]|@)/i.test(m)) return true;
  if (/^LINE\s/.test(m)) return true; // the app's own all-caps spelling
  const bare = /^line\s+(\S+)$/i.exec(m);
  if (!bare) return false; // "linear", "lineage" — not the label at all
  const tok = bare[1];
  return /^[A-Za-z][A-Za-z0-9._-]{3,}$/.test(tok) && /\d|_|[A-Za-z0-9]{2}\.[A-Za-z0-9]{2}/.test(tok);
}

// WARD pass guard. Thai ห้อง / หอผู้ป่วย keep their original behaviour. After the
// English word "ward" an identifier carries a digit or a capital (5A, 4B, 7, ICU,
// A); an all-lowercase word of 2+ letters is prose ("ward round", "ward is"), and
// a few capitalised headings ("Ward Round", "WARD STAFF") are prose too.
const WARD_PROSE = new Set(['round', 'rounds', 'staff', 'nurse', 'nurses', 'team', 'teams', 'manager', 'sister', 'clerk']);
function wardGuard(m) {
  if (!/^ward/i.test(m)) return true;
  const tok = m.replace(/^ward\s+/i, '');
  if (/^[a-z]{2,}$/.test(tok)) return false;
  return !WARD_PROSE.has(tok.toLowerCase());
}

// Thai administrative-place pass (ตำบล/ต. อำเภอ/อ. จังหวัด/จ., and the รพ.สต. facility).
//   - ต่างจังหวัด ("up-country"), ทุกจังหวัด are generic, but a quantifier does NOT stop a place that
//     follows ("ต่างจังหวัดเชียงใหม่", "แต่ละจังหวัด ลำพูน" — still masked). No lookbehind: the
//     generic uses survive through the lead list below (ต่างจังหวัด มีไข้ / … เพื่อ…) or simply because
//     no Thai word follows. ต่างอำเภอ / ทุกตำบล + a word stay masked exactly as on master.
//   - รพ.สต. (sub-district health-promoting hospital) is matched as ONE keyword. Before, its inner
//     "ต." was read as ตำบล and the label was corrupted to "รพ.ส[ADDR-n]". Now the label survives and
//     only a following place name (the village / tambon the facility is named after) is masked.
//   - After จังหวัด / จ. / รพ.สต. a following word that is a grammatical or clinical lead
//     (รพ.จังหวัด เพื่อ…, ต่อ รพ.สต. และ…) is not a place. For จังหวัด the lead list was checked
//     against all 77 province names (tests/pii-false-positives.test.js re-checks every one).
//     ตำบล/อำเภอ get NO lead list — there are thousands of them and some do begin with a lead
//     (อำเภอจะนะ, ตำบลในเมือง) — so they keep the original, demonstrative-only exclusion.
const TH_ADMIN_RE = /(รพ\.\s?สต\.|สต\.|ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.)(\s*)([ก-ฮะ-๎]+)/g;
const TH_DEMONSTRATIVE_RE = /^(?:นี้|นั้น|ไหน|ใด|เดียวกัน)/;
const TH_PROVINCE_NON_PLACE_LEADS = [
  'เพื่อ', 'ที่', 'และ', 'หรือ', 'ได้', 'ไม่', 'แล้ว', 'จาก', 'ด้วย', 'มา', 'มี', 'เป็น', 'ใกล้เคียง',
  'อื่น', 'ของ', 'ให้', 'ก็', 'จะ', 'ซึ่ง', 'เพราะ', 'ส่ง', 'ตรวจ', 'รักษา', 'ทำ', 'ใน', 'กับ', 'ไป',
  'โดย', 'หลัง', 'ก่อน', 'อยู่', 'แต่',
];
// A facility is named after a village / tambon, so its list is narrower (no ที่, ใน, จะ, มา, มี).
const TH_FACILITY_NON_PLACE_LEADS = [
  'เพื่อ', 'และ', 'หรือ', 'แล้ว', 'ได้', 'ไม่', 'จาก', 'ด้วย', 'ของ', 'ให้', 'ซึ่ง', 'เพราะ', 'ก็',
  'ใกล้', 'อื่น', 'เป็น',
];
function applyThAdminPass(text, token) {
  TH_ADMIN_RE.lastIndex = 0;
  return text.replace(TH_ADMIN_RE, (match, kw, ws, place) => {
    if (TH_DEMONSTRATIVE_RE.test(place)) return match;
    const facility = kw.endsWith('สต.');
    if (facility) {
      if (wordAt(place, 0, TH_FACILITY_NON_PLACE_LEADS)) return match;
      return kw + ws + token('ADDR', place);
    }
    if ((kw === 'จังหวัด' || kw === 'จ.') && wordAt(place, 0, TH_PROVINCE_NON_PLACE_LEADS)) return match;
    return token('ADDR', match); // unchanged: keyword + place collapse into one [ADDR-n]
  });
}

// A phone's group separator: a dot with any spaces around it, or one space or dash.
const PHONE_SEP = '(?:\\s*\\.\\s*|[\\s-])';

// A real day and month.
function dottedDateGuard(m) {
  const [d, mo] = m.split('.').map(Number);
  return d >= 1 && d <= 31 && mo >= 1 && mo <= 12;
}
// A section, clause or version number written like a date (หัวข้อ 1.2.10, version 1.2.10) is no date.
const NUMBERING_LABEL = String.raw`(?<!(?:หัวข้อ|ข้อ|บทที่|บท|มาตรา|[Ss]ection|[Ss]ec\.?|[Cc]hapter|[Vv]ersion|[Vv]er\.?|[Rr]ev\.?|[Vv])\s{0,3})`;

// No phone or date starts or ends inside a decimal (Na 140.00 139.50, Hb 12.5. 11.2): never right before
// ".<digit>", and never right after "<digit>." when what follows reads as a decimal fraction, 1-8 digits not
// followed by another '.', '/', '-' or digit. A numbered list item (1.081.234.5678, 1.0812345678, 1.20/10/2569)
// is not a decimal and is still masked. Wrapped around every phone and date pattern below. A loose undotted phone run
// ends where its digits end instead (`tail` (?!\d)): backing off before ".<digit>" would leave its last digit in clear.
const NOT_IN_DECIMAL = (src, tail = '(?!\\.\\d)') => `(?!(?<=\\d\\.)\\d{1,8}(?![\\d./-]))(?:${src})${tail}`;
const numericRe = (src, tail) => new RegExp(NOT_IN_DECIMAL(src, tail), 'g');

// Each entry runs against the working text in order. `fn` receives (text, token).
const PASSES = [
  // --- Structured identifiers FIRST (longest / most specific) ---

  // Email addresses.
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    cat: 'EMAIL',
  },

  // LINE IDs. Forms covered:
  //   "line: foo_bar" / "LINE ID: foo.bar"  (English label, with colon)
  //   "ไลน์ foo" / "ไลน์ไอดี foo"            (Thai label, colon optional)
  //   "LINE @foo" / "ไลน์ @foo"             (handle form, the @ is the anchor)
  // The label word (line/ไลน์/ไลน์ไอดี) is consumed too so it is not left
  // dangling; we emit just the token. An optional leading @ on the id is eaten.
  //
  // The ENGLISH word "line" is everyday clinical vocabulary (first-line therapy,
  // IV line, joint line tenderness, line of treatment), so it only counts as the
  // LINE-app label with an explicit marker:
  //   line id … | line: … | line @… | LINE … (the app's all-caps name)
  //   | line <token shaped like an id: starts with a letter, >= 4 chars (LINE's
  //     own minimum), and carries a digit, an underscore or a dotted segment>
  // and never when glued to a preceding hyphen/word (first-line, A-line, baseline).
  // The Thai label ไลน์ is unambiguous (a catheter "line" is สาย) and keeps its
  // optional colon.
  {
    re: /(?<![-\w])[Ll][Ii][Nn][Ee](?:\s*[Ii][Dd]\b)?\s*[:：]?\s*@?[A-Za-z0-9._-]{2,}|ไลน์(?:ไอดี)?\s*[:：]?\s*@?[A-Za-z0-9._-]{2,}/g,
    cat: 'LINE',
    guard: lineIdGuard,
  },

  // Every pass from here on that is not a NAME pass reads the ASCII view of the text: ๐–๙, ٠–٩, ０–９ and every
  // other decimal digit as 0–9, and full-width ＋－．（） as +-.() (#440; see asciiView and applyPass).

  // Thai national ID: 13 digits, with or without the X-XXXX-XXXXX-XX-X dashes.
  {
    re: /\b\d(?:[\s-]?\d){12}\b/g,
    cat: 'ID',
    // Guard: only when the digits actually total 13 (the loose run above could
    // otherwise straddle unrelated numbers separated by spaces).
    // A run that opens with a whole grouped phone (081-234-5678 089-876-5432) is two phones, not one ID; an ID
    // in category 0 (0-1234-56789-12-3, 0123456789012) never groups that way.
    guard: (m) => m.replace(/\D/g, '').length === 13 && !/^\(?0\d{1,2}\)?[\s-]+\d{3,4}[\s-]+\d{3,4}[\s-]/.test(m),
  },

  // HN (hospital number) explicit code field — kept as its own category since
  // it is the primary local patient identifier and distinct from MRN/AN.
  // Allow internal spaces/dashes in the digit run (e.g. "HN 12-34567"); the
  // guard re-checks the total digit count so a loose run can't over-match.
  {
    re: /\bHN\s*[:#]?\s*\d(?:[\s-]?\d){3,13}/gi,
    cat: 'HN',
    guard: (m) => {
      const d = m.replace(/\D/g, '').length;
      return d >= 4 && d <= 12;
    },
  },
  // MRN / AN explicit code fields (same internal-separator tolerance).
  {
    re: /\b(?:MRN|AN)\s*[:#]?\s*\d(?:[\s-]?\d){3,13}/gi,
    cat: 'MRN',
    guard: (m) => {
      const d = m.replace(/\D/g, '').length;
      return d >= 4 && d <= 12;
    },
  },

  // Phone numbers — international +66 / 66 forms and Thai national forms.
  // Covered groupings (spaces, dashes, parens, optional trunk "(0)"):
  //   +66 8 1234 5678   +66-81-234-5678   +66 (0) 81 234 5678
  //   66812345678 (country code, no plus)
  //   081-234-5678   0812345678   (081) 234-5678   02-123-4567
  //
  // International: optional +, "66", optional "(0)" trunk, then the national
  // number. The guard checks the national digit count (after stripping 66) so
  // it cannot latch onto an unrelated long number.
  {
    re: numericRe(String.raw`(?<!\d)\+?66[\s-]?(?:\(0\)[\s-]?)?\d(?:[\s()-]{0,8}\d){6,9}`, '(?!\\d)'),
    cat: 'PHONE',
    guard: (m) => {
      // national number: 8 digits (landline) or 9 (mobile); a written trunk 0
      // adds one (10). Accept 8-10 after stripping the leading 66.
      const nat = m.replace(/\D/g, '').replace(/^66/, '');
      return nat.length >= 8 && nat.length <= 10;
    },
  },
  {
    // Thai national: leading 0 (possibly parenthesised "(081)"), then 8-9 more
    // digits, allowing space/dash/paren grouping. Guarded to 9-10 digits so it
    // never eats a longer run or a bare lab count (which has no leading 0).
    re: numericRe(String.raw`(?<!\d)\(?0\d\)?(?:[\s()-]{0,8}\d){7,9}`, '(?!\\d)'),
    cat: 'PHONE',
    guard: (m) => {
      const d = m.replace(/\D/g, '').length;
      return d >= 9 && d <= 10;
    },
  },
  // Dotted groups, national or +66 (081.234.5678, 081.2345678, 0812.345.678, 02.1234567, +66.812345678,
  // 081. 234.5678), after any label or punctuation (โทร.081…, Tel.081…). Its own pass so '.' never joins the loose
  // runs above. A national number opens with 0 and one to three more digits, then groups of two or more (081.234.56.78);
  // a +66 number (+66.81…, +6681.234…) takes groups of three or four after its one- or two-digit area code, so a lab
  // list (Cr 0.85 0.92 1.10, Cr 0.66 0.70 0.81) or a dotted date (05.12.2569) is no phone; no match starts inside a
  // number or a decimal or stops before one. Only a match holding a dot counts: the passes above own every undotted
  // form.
  {
    re: new RegExp(
      NOT_IN_DECIMAL(
        `(?<!\\d)(?:\\+?66${PHONE_SEP}?(?:\\(0\\)${PHONE_SEP}?)?\\d{1,2}(?:${PHONE_SEP}?\\d{3,4}){1,2}` +
          `|\\(?0\\d{1,3}\\)?(?:${PHONE_SEP}\\d{2,7}){1,3})(?!\\d)`
      ),
      'g'
    ),
    cat: 'PHONE',
    guard: (m) => {
      if (!m.includes('.')) return false;
      const intl = /^\+?66/.test(m);
      const nat = m.replace(/\D/g, '').slice(intl ? 2 : 0);
      return nat.length >= (intl ? 8 : 9) && nat.length <= 10; // the same counts as the two passes above
    },
  },

  // --- Dates (kept stable category so repeated dates collapse) ---
  { re: numericRe(String.raw`\b\d{1,2}\/\d{1,2}\/\d{2,4}\b`), cat: 'DATE' },
  { re: numericRe(String.raw`\b\d{4}-\d{2}-\d{2}\b`), cat: 'DATE' },
  // Dotted day.month.year (20.10.2026, 05.12.2569, 20. 10. 2026, 5.10.69): a real day and month, not after a
  // section or version label.
  {
    re: numericRe(String.raw`${NUMBERING_LABEL}\b\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}\b`),
    cat: 'DATE',
    guard: dottedDateGuard,
  },

  // --- Ward ---
  // \b only on the English branch (it is ASCII-only and would never match before
  // a Thai keyword): without it "toward the left" became "to[WARD-n] left".
  // wardGuard lets English prose after "ward" through (ward round, ward is).
  { re: /(?:\bward|ห้อง|หอผู้ป่วย)\s+[A-Za-z0-9]+/gi, cat: 'WARD', guard: wardGuard },

  // --- Home address (Thai) ---
  // House number: "บ้านเลขที่ 99/1" / "เลขที่ 99/1". Capture the number token
  // (digits, optional /sub and -range). The keyword is distinctive.
  { re: /(?:บ้านเลขที่|เลขที่)\s*[0-9]+(?:[/-][0-9]+)*/g, cat: 'ADDR' },
  // Moo (village cluster) number: "หมู่ 5" / "หมู่ที่ 5".
  // Negative lookahead on บ้าน so the common word หมู่บ้าน (housing estate) is
  // NOT consumed; require a digit so prose "หมู่ที่..." without a number is safe.
  // NOTE: the bare abbreviation "ม.5" is deliberately NOT matched — "ม." is an
  // overloaded Thai abbreviation (มัธยม = school grade, มหาวิทยาลัย, มาตรา) and
  // masking it would over-mask common non-address text. Spelled-out หมู่ only.
  { re: /หมู่(?!บ้าน)\s*(?:ที่)?\s*[0-9]+/g, cat: 'ADDR' },
  // Administrative place names: ตำบล/ต. อำเภอ/อ. จังหวัด/จ. + the place token.
  // The place is a glued Thai run. We exclude a few demonstrative/pronoun leads
  // (นี้ "this", นั้น "that") so prose like "ตำบลนี้" survives. The province
  // alone (จังหวัด...) IS masked here: a named province is an address component.
  // Clinical false-positive shields (ต่างจังหวัด, รพ.สต., รพ.จังหวัด เพื่อ…): see applyThAdminPass.
  { cat: 'ADDR', kind: 'th-admin' },

  // --- Intake hints: the KNOWN patient identifier from ple_patient_refs (on-prem), masked verbatim
  // BEFORE the name regexes so it becomes the authoritative [NAME-n] referent. Closes the bare,
  // unlabelled-name leak for any name the physician recorded at intake. ---
  { cat: 'NAME', kind: 'intake-hint' },

  // --- Nicknames (run BEFORE the ชื่อ labelled rule; ชื่อ is its prefix) ---
  { re: TH_NICKNAME_RE, cat: 'NAME', kind: 'th-nickname' },
  { re: EN_NICKNAME_RE, cat: 'NAME', kind: 'en-nickname' },

  // --- Names ---
  // Order: labelled fields, then title-led. Each registers its parts as aliases
  // so the final 'bare-name' pass can catch later standalone occurrences.
  { re: TH_LABELLED_RE, cat: 'NAME', kind: 'th-labelled' },
  { re: TH_SURNAME_RE, cat: 'NAME', kind: 'th-surname' },
  { re: TH_NAME_RE, cat: 'NAME', kind: 'th-title' },
  { re: EN_NAME_RE, cat: 'NAME', kind: 'en-title' },
  // Bare occurrences of an already-seen name part (no title), e.g. a transcript
  // that introduces "นพ.สมชาย" then later writes just "สมชาย". Built dynamically
  // from the registry; only fires for names already masked in THIS call.
  { cat: 'NAME', kind: 'bare-name' },
  // Chinese-Thai clan surnames (แซ่X) — masked VERBATIM in any position (the แซ่ prefix is an
  // unambiguous surname marker), closing the bare-surname leak after a title-led given name.
  { cat: 'NAME', kind: 'th-clan-surname' },
  // Thai given-name gazetteer — best-effort backstop for a bare name with NO intake/title/label,
  // guarded by boundary + clinical-lead so clinical phrases survive.
  { cat: 'NAME', kind: 'th-gazetteer' },
  // Bare surname after a masked Thai given name ("[NAME-1] ใจดี"), from ANY Thai name rule above.
  // Runs LAST among name passes so every given-name token already exists.
  { cat: 'NAME', kind: 'th-given-surname' },

  // --- Age (AFTER ids/phones so it never eats their digits) ---
  // Thai: "อายุ 45 ปี", "45 ปี", "อายุ 45". No trailing \b after ปี — \b is
  // ASCII-only and would fail to match at a Thai/space transition.
  { re: /อายุ\s*\d{1,3}\s*ปี?/g, cat: 'AGE' },
  { re: /\b\d{1,3}\s*ปี/g, cat: 'AGE' },
  { re: /อายุ\s*\d{1,3}\b/g, cat: 'AGE' },
  // English: require an explicit age marker ("old" or "y/o" or "age NN") so
  // that bare durations like "for 5 years" / "3 years ago" SURVIVE.
  { re: /\b\d{1,3}[\s-]?(?:years?|yrs?)[\s-]?old\b/gi, cat: 'AGE' }, // 45 years old / 45-year-old
  { re: /\b\d{1,3}\s?y\/?o\b/gi, cat: 'AGE' },                       // 62 y/o, 30yo
  { re: /\bage[d]?\s*[:#]?\s*\d{1,3}\b/gi, cat: 'AGE' },             // age 55, aged 30
];

// Register each whitespace-separated part of a name as an alias of `tok`, so a
// later bare occurrence of just the given name or surname reuses the token.
// A Thai part glued to a particle or clinical tail ("นายอรุณครับ" takes อรุณครับ) also aliases its head
// (nameHead: อรุณ), so a later bare "อรุณ" folds in.
function registerNameAliases(token, surface, tok) {
  for (const part of surface.split(/\s+/)) {
    if (part.length >= 2 && !MED_SHIELD.has(part)) token.alias('NAME', part, tok);
    const head = nameHead(part);
    if (head) token.alias('NAME', head, tok);
  }
}

// The bare-name pass: replace standalone occurrences of any name part already
// masked in this call. Built here because the alias set only exists at runtime.
function applyBareNamePass(text, token) {
  const known = token.knownAliases('NAME');
  const parts = Object.keys(known)
    // Mask longer aliases first so "สมชาย ใจดี" is tried before "สมชาย".
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const part of parts) {
    const isThai = /[฀-๿]/.test(part);
    // Thai has no word boundaries (\b is ASCII-only), so a short Thai alias
    // could hit inside an unrelated word. Require >= 3 chars for Thai to keep
    // the substring match conservative. English uses \b and is safe at >= 2.
    if (isThai && part.length < 3) continue;
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = isThai
      ? new RegExp(escaped, 'g')
      : new RegExp(`\\b${escaped}\\b`, 'g');
    out = out.replace(re, known[part]);
  }
  // Surname aliases (token.wordAlias). Latin: whole words only. Thai: a whole run always; inside a longer
  // glued run ("ญาติของใจดีโทรมา") only when that run is not wholly clinical vocabulary, so a surname that
  // is also part of prose ("จิตใจดีขึ้น" = จิตใจ + ดีขึ้น) leaves the prose alone.
  const words = token.knownWordAliases('NAME');
  const ordered = Object.keys(words).sort((a, b) => b.length - a.length);
  for (const word of ordered.filter((w) => !TH_LETTER_RE.test(w))) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi'), words[word]); // Jaidee2, JAIDEE
  }
  // Inside a glued run only aliases of 3+ letters: an initial (the ก of "นายสมชาย ก.") sits in many words.
  const thai = ordered.filter((w) => TH_LETTER_RE.test(w) && !/\s/.test(w) && w.length >= 3);
  return out.replace(/[\u0E01-\u0E4E]+/g, (run) => {
    if (words[run] !== undefined) return words[run];
    if (thai.length === 0) return run;
    if (!thai.some((w) => run.includes(w)) || isClinicalRun(run)) return run;
    for (const w of thai) run = run.split(w).join(words[w]);
    return run;
  });
}

// The intake-hint pass: deterministically scrub the patient identifier(s) the physician recorded in
// ple_patient_refs (passed in by the backend, on-prem — never forwarded to the cloud). These are
// KNOWN PII strings, so they are masked even unanchored mid-sentence — this is what closes the bare,
// unlabelled-name leak. Each hint pre-registers as the authoritative [NAME-n] referent so a later
// title-led/bare occurrence of the same name folds into one token.
function applyHintPass(text, token, hints) {
  if (!hints || hints.length === 0) return text;
  const ordered = [...new Set(hints)].sort((a, b) => b.length - a.length); // full name before a part
  let out = text;
  for (const hint of ordered) {
    const h = typeof hint === 'string' ? hint.replace(ZERO_WIDTH_RE, '').trim() : ''; // same as the text
    if (!h || MED_SHIELD.has(h)) continue;
    const isThai = /[ก-ฮะ-๎]/.test(h);
    if (isThai ? h.length < 3 : h.length < 2) continue; // conservative for space-less Thai
    const tok = token('NAME', h);
    registerNameAliases(token, h, tok);
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = isThai ? new RegExp(escaped, 'g') : new RegExp(`\\b${escaped}\\b`, 'g');
    out = out.replace(re, tok);
  }
  return out;
}

// The Thai given-name gazetteer pass (best-effort backstop; runs LAST among name passes): mask a
// curated common given name ONLY at a detectable boundary (not glued after another Thai letter) AND
// when it is standalone or immediately followed by a clinical-lead word (the "สมชายมาด้วยไข้" form).
// The double guard keeps clinical phrases intact (over-masking is the worse error). Given names are
// ambiguous with clinical compounds, so this stays conservative — unlike the unambiguous แซ่ clan
// surnames (applyClanSurnamePass), which are masked verbatim.
const TH_LETTER_RE = /[ก-ฮะ-๎]/;
// A gazetteer name glued right after one of these relational words (แม่ของสมศรี, คุณหมอให้ยาสมศรี is
// handled by the คุณ shield, but บอกให้สมศรี / ไปกับสมศรี / แม่ของสมศรีโทรมา are not after any title) is
// masked whatever follows it: ของ/กับ/ให้ + a curated personal name is a person. Over-masking a rare
// clinical "ของสมบัติ" is the cheap side of that trade.
const TH_RELATIONAL_PRECEDERS = ['ของ', 'กับ', 'ให้'];
function applyGazetteerPass(text, token) {
  const names = [...TH_GIVEN_NAMES].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:${alt})`, 'g');
  return text.replace(re, (match, offset, full) => {
    if (MED_SHIELD.has(match)) return match;
    const prev = offset > 0 ? full[offset - 1] : '';
    const before = full.slice(Math.max(0, offset - 3), offset);
    const relational = TH_RELATIONAL_PRECEDERS.some((w) => before.endsWith(w));
    if (TH_LETTER_RE.test(prev) && !relational) return match; // glued into a preceding word — skip
    const after = full.slice(offset + match.length);
    const standalone = !after || !TH_LETTER_RE.test(after[0]); // space / punct / non-Thai / end follows
    if (relational || standalone || startsWithClinicalLead(after)) {
      const tok = token('NAME', match);
      registerNameAliases(token, match, tok);
      return tok;
    }
    return match;
  });
}

// The Chinese-Thai clan-surname pass: mask any curated "แซ่X" surname VERBATIM, anywhere it appears.
// The แซ่ prefix is an unambiguous surname marker (it never occurs in clinical text), so — unlike the
// ambiguous given-name gazetteer — NO boundary/clinical-lead guard is needed. That also closes the
// glued-surname residual the conservative guard leaves (e.g. "...แซ่ลี้เข้ารับการรักษา"). Exact-string
// matching keeps delimitation clean (a generic แซ่+run regex can't tell where a glued surname ends).
function applyClanSurnamePass(text, token) {
  const names = [...TH_SURNAMES].sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:${alt})`, 'g');
  return text.replace(re, (match) => {
    const tok = token('NAME', match);
    registerNameAliases(token, match, tok);
    return tok;
  });
}

// The bare-surname pass (#224, #238). A Thai name is "given surname", and every Thai name rule above masks
// only the given name — so "สมชาย ใจดี" / "นายสมชาย ใจดี" left "[NAME-1] ใจดี", and the surname reached the
// model whenever no patient_ref / chief complaint seeded it. Owner ruling (2026-10-29): "Mask any word after
// a name". The word right after a masked Thai given name takes the SAME [NAME-n] and becomes an alias of it
// (a later "ใจดี", in this text or another one in the call, folds in too) UNLESS all of it splits into words
// of the short, hand-reviewed clinical continuation allowlist (isClinicalRun over TH_CLINICAL_VOCAB:
// TH_CLINICAL_CONTINUATIONS, pii-clinical-words.th.js, plus the hand lists in this file). No prefix lets a
// word through, and a word built of everyday words (ปลอดภัย, ถาวร, ยืนยาว) is taken; over-masking a clinical
// statement such as "นายสมชาย แข็งแรงดี" is accepted. To keep a clinical phrase, add its words to the
// allowlist after the checks its header lists — never loosen the given-name side.
// Covered spellings: any separator in SURNAME_SEP, line breaks included (owner ruling: "Yes, cross the
// line"); invisible format characters, removed up front by stripPii; a two-part "ณ อยุธยา"; a Latin surname
// in any case, with a romanised "na" ("นายสมชาย JAIDEE", "na Ayudhya"); and the surname written BEFORE the
// given name ("ใจดี นายสมชาย"), for a word of at most SURNAME_BEFORE_MAX letters (a longer run is a clause).
// A surname found here can expose another one ("ใจดี ทองคำ" once ใจดี is known), so the pass repeats until
// nothing new is found; across the texts of one call, primeRegistry does the same.
// Only given-name tokens qualify: not a แซ่ clan surname, and not the token right after the นามสกุล keyword
// (that one already IS the surname).
const TH_POST_NAME_VERBS = [
  // follow a name in the existing exact-output tests (นพ.สมชาย ปรึกษา…, ดูแลผู้ป่วย, พบ, กลับมา, ยังมีไข้,
  // โทร, ต้องได้)
  'ปรึกษา', 'ดูแล', 'พบ', 'กลับ', 'ยัง', 'โทร', 'ต้อง',
  // history-taking verbs: masking them would erase smoking / alcohol / medication history PIS-7 scores
  'ปฏิเสธ', 'สูบ', 'ดื่ม', 'กิน', 'ทาน', 'รับ', 'ขอ',
];
const TH_TITLE_WORDS = TH_TITLES.map((t) => t.replace(/\\/g, ''));
const TH_ABBREVIATED_TITLES = TH_TITLE_WORDS.filter((t) => t.includes('.')); // นพ. พญ. ด.ช. ด.ญ.
// A surname component or a given name is never vocabulary, even when a hand list above holds it; nor is
// มาก ("much", a คุณ-shield particle), which builds surnames (มากมี, มากมูล).
const NOT_VOCABULARY = new Set([...TH_SURNAME_MORPHEMES, ...TH_GIVEN_NAMES, 'มาก']);
const TH_CLINICAL_VOCAB = new Set([
  ...TH_CLINICAL_LEADS, ...TH_RUN_WORDS, ...TH_PROVINCE_NON_PLACE_LEADS, ...TH_POST_NAME_VERBS,
  ...TH_CLINICAL_CONTINUATIONS, ...TH_TITLE_WORDS, 'ชื่อ', 'นามสกุล',
  'ๆ', 'ฯ', // repetition / abbreviation marks
].filter((w) => !NOT_VOCABULARY.has(w)));
const TH_VOCAB_MAX = Math.max(...[...TH_CLINICAL_VOCAB].map((w) => w.length));
// True when ALL of `run` splits into allowlist words (word-break over a closed list; O(len x longest word)).
// A split into several words must hold one of 3+ letters: short words alone combine into names (ตา + โต).
function isClinicalRun(run) {
  if (TH_CLINICAL_VOCAB.has(run)) return true;
  // reach[i]: bit 1 = run[0, i) splits into words, bit 2 = such a split holds a word of 3+ letters
  const reach = new Uint8Array(run.length + 1);
  reach[0] = 1;
  for (let i = 0; i < run.length; i++) {
    if (!reach[i]) continue;
    for (let l = 1; l <= TH_VOCAB_MAX && i + l <= run.length; l++) {
      if (TH_CLINICAL_VOCAB.has(run.slice(i, i + l))) reach[i + l] |= reach[i] | (l >= 3 ? 3 : 1);
    }
  }
  return (reach[run.length] & 2) === 2;
}
// English words (any case) that follow a name in mixed notes without being a surname — the Latin side of the
// allowlist, equally short and reviewed.
const EN_CLINICAL_CONTINUATIONS = new Set([
  'the', 'and', 'with', 'for', 'has', 'had', 'was', 'not', 'plan', 'admit', 'admitted', 'note', 'case', 'ward',
  'bed', 'room', 'day', 'post', 'pre', 'test', 'lab', 'labs', 'dose', 'stop', 'start', 'follow', 'visit', 'refer',
  'presented', 'presents', 'complains', 'complained', 'denies', 'denied', 'reports', 'reported', 'came', 'comes',
  'developed', 'received', 'takes', 'took', 'refused', 'agreed', 'feels', 'felt', 'says', 'said', 'are', 'were',
  'dengue', 'covid', 'influenza', 'malaria', 'aspirin', 'warfarin', 'insulin', 'heparin', 'morphine',
]);
// Long drug-name endings after a 3+ letter stem (Amoxicillin, Paracetamol, Omeprazole). Short, ambiguous
// endings (-vir, -mab, -sone) are left out: a missed drug is over-masked, a wrongly spared surname leaks.
const EN_DRUG_SUFFIX_RE = /^[A-Za-z]{3,}(?:cillin|mycin|cycline|statin|sartan|olol|azole|oxacin|azepam|tidine|formin|profen|etamol|dipine|parin|xaban)$/i;
// Invisible format characters (zero-width space / joiners, soft hyphen, bidi marks).
const ZERO_WIDTH_RE = /\p{Cf}/gu;
// Any whitespace, line breaks and NEL included (owner ruling), or list / bracket / quote punctuation.
const SURNAME_SEP = '(?:\\s|\\u0085|[,，、/()（）\\-–—:"“”\'‘’])+';
const SURNAME_BEFORE_MAX = 20;
// Bound on the find-a-surname-then-look-again loop (one text here, the texts of one call in primeRegistry).
// Each round is linear; a real record needs two or three. Hitting the bound throws: the route answers 500
// rather than send a text that may still hold a surname (fail closed).
const SURNAME_MAX_ROUNDS = 32;
// Marks a token this pass put in a surname slot, so the next round never takes the word after a surname for
// another surname ("นายสมชาย บุญมา ไปทำบุญ"). A private-use character: stripPii removes it from the input
// and from its output.
const SURNAME_MARK = '\uE000';
const SURNAME_MARK_RE = /\uE000/g;
const TH_GIVEN_SURNAME_RE = new RegExp(
  `(?<!นามสกุล\\s*)(?<!${SURNAME_MARK})(\\[NAME-\\d+\\])(${SURNAME_SEP})(ณ${SURNAME_SEP}${TH_NAME}|${TH_NAME}|(?:[Nn][Aa]\\s+)?[A-Za-z]{3,}(?:-[A-Za-z]+)?)`,
  'g'
);
const TH_SURNAME_BEFORE_RE = new RegExp(
  `(?<![\\u0E01-\\u0E4EA-Za-z0-9\\]])(${TH_NAME})(${SURNAME_SEP})((?:${TH_TITLES.join('|')})?)(\\[NAME-\\d+\\])`,
  'g'
);
function givenNameTokens(token) {
  const out = new Set();
  const add = (value, tok) => {
    if (TH_LETTER_RE.test(value) && !/\s/.test(value) && !TH_SURNAMES.has(value)) out.add(tok);
  };
  for (const e of token.entries()) if (e.category === 'NAME') add(e.value, e.token);
  for (const map of [token.knownAliases('NAME'), token.knownWordAliases('NAME')]) {
    for (const [value, tok] of Object.entries(map)) add(value, tok);
  }
  return out;
}
// The shortest head of a Thai name word before a wholly allowlisted tail (ใจดีครับ → ใจดี, อรุณครับ → อรุณ,
// ใจดีมาด้วยไข้ → ใจดี), or ''. The head must be 3+ letters, not itself allowlisted and not a lone surname
// component: a head such as แก้ว (แก้วใส) or บุญ (บุญมา) is an ordinary word and would mask it everywhere in the
// history. Heads are tried up to NAME_HEAD_MAX letters, so the cost stays linear in the word's length.
const NAME_HEAD_MAX = 30;
const SURNAME_MORPHEME_SET = new Set(TH_SURNAME_MORPHEMES);
// A lone component (บุญ, แก้ว) — not a whole surname built of two (ใจ + ดี, ศรี + สุข).
function isLoneMorpheme(w) {
  if (!SURNAME_MORPHEME_SET.has(w)) return false;
  for (let i = 1; i < w.length; i++) if (SURNAME_MORPHEME_SET.has(w.slice(0, i)) && SURNAME_MORPHEME_SET.has(w.slice(i))) return false;
  return true;
}
function nameHead(word) {
  if (!TH_LETTER_RE.test(word)) return '';
  for (let i = 3; i < word.length && i <= NAME_HEAD_MAX; i++) {
    const head = word.slice(0, i);
    if (isLoneMorpheme(head) || isClinicalRun(head) || !isClinicalRun(word.slice(i))) continue;
    return head;
  }
  return '';
}
// Bind a taken surname (and its head, see nameHead) to `tok`.
function aliasSurname(token, surname, tok) {
  token.wordAlias('NAME', surname, tok);
  const parts = surname.split(new RegExp(SURNAME_SEP));
  if (parts.length > 1) for (const p of parts) if (p.length >= 3) token.wordAlias('NAME', p, tok); // ณ อยุธยา
  const head = nameHead(surname);
  if (head) token.wordAlias('NAME', head, tok);
}
function isSurnameCandidate(word, full, wordStart) {
  if (MED_SHIELD.has(word)) return false;
  if (/^[A-Za-z]/.test(word)) {
    const last = word.split(/\s+/).pop().toLowerCase(); // "na Ayudhya" → ayudhya
    return !EN_CLINICAL_CONTINUATIONS.has(word.toLowerCase()) && !EN_CLINICAL_CONTINUATIONS.has(last)
      && !EN_DRUG_SUFFIX_RE.test(last);
  }
  if (/^ณ[^ก-๎]/.test(word)) return true; // ณ อยุธยา
  // "[NAME-1] นพ.[NAME-2]": the head of an abbreviated title, not a surname.
  if (TH_ABBREVIATED_TITLES.some((t) => full.startsWith(t, wordStart))) return false;
  return !isClinicalRun(word);
}
// One round: take every surname next to a given-name token in `text`. Returns [text, foundOne].
function takeSurnames(text, token) {
  const givenTokens = givenNameTokens(token);
  if (givenTokens.size === 0) return [text, false];
  let captured = false;
  let out = text.replace(TH_GIVEN_SURNAME_RE, (match, tok, sep, word, offset, full) => {
    if (!givenTokens.has(tok)) return match;
    if (!isSurnameCandidate(word, full, offset + tok.length + sep.length)) return match;
    aliasSurname(token, word, tok);
    captured = true;
    return tok + sep + SURNAME_MARK + tok;
  });
  // Only the taken token is marked, never the given name after it: a word wrongly taken here (an unknown
  // word before a name) must not stop the real surname after the given name from being taken.
  out = out.replace(TH_SURNAME_BEFORE_RE, (match, word, sep, title, tok) => {
    if (!givenTokens.has(tok) || word.length > SURNAME_BEFORE_MAX) return match;
    if (MED_SHIELD.has(word) || isClinicalRun(word)) return match;
    aliasSurname(token, word, tok);
    captured = true;
    return SURNAME_MARK + tok + sep + title + tok;
  });
  // A repeat of the new alias elsewhere in THIS text ran past the bare-name pass already: catch it now.
  return [captured ? applyBareNamePass(out, token) : out, captured];
}
function applyGivenSurnamePass(text, token) {
  let out = text;
  for (let round = 0; round < SURNAME_MAX_ROUNDS; round++) {
    const [next, found] = takeSurnames(out, token);
    out = next;
    if (!found) return out;
  }
  throw new Error('PII filter: surname search did not settle');
}

// The ASCII view a numeric pass reads: every BMP decimal digit (Thai ๐–๙, Arabic-Indic ٠–٩ and ۰–۹, full-width ０–９,
// Lao, Devanagari …) as 0–9, and the full-width ASCII block (＋ － ． （ ） Ｈ Ｎ …) as its ASCII letter. One UTF-16 unit
// each way, so the view is index-for-index the original: a pass matches on it and cuts the original, and text left
// unmasked keeps its own digits. Unicode lays every decimal digit set out as a run of ten from zero.
const ASCII_VIEW = (() => {
  const map = new Map();
  let run = 0;
  for (let c = 0x80; c <= 0xffff; c += 1) {
    const ch = String.fromCharCode(c);
    run = /\p{Nd}/u.test(ch) ? run + 1 : 0;
    if (run) map.set(ch, String.fromCharCode(0x30 + ((run - 1) % 10)));
  }
  for (let c = 0xff01; c <= 0xff5e; c += 1) map.set(String.fromCharCode(c), String.fromCharCode(c - 0xfee0));
  return map;
})();
const ASCII_VIEW_RE = new RegExp(`[${[...ASCII_VIEW.keys()].join('').replace(/[\]\\^-]/g, '\\$&')}]`, 'g');
const asciiView = (s) => s.replace(ASCII_VIEW_RE, (c) => ASCII_VIEW.get(c));

// The longest match of `re` that starts at `at`, is shorter than `len`, ends where a word or number ends (never
// inside one, never before ".<digit>") and passes `guard`; null when there is none. The regex runs on the text cut
// at each candidate end, so its own pattern still decides every shorter match; the cut point is checked against the
// full text, which the cut hides from the regex's lookahead.
const GUARD_FALLBACK_MAX = 128; // above the longest loose phone run (13 digits, gaps of up to 8)
function longestGuarded(view, re, at, len, guard) {
  if (len > GUARD_FALLBACK_MAX) return null;
  const rx = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  for (let e = len - 1; e > 0; e -= 1) {
    const next = view.slice(at + e, at + e + 2);
    if (/^[A-Za-z0-9]|^\.\d/.test(next)) continue;
    rx.lastIndex = at;
    const m = rx.exec(view.slice(0, at + e));
    if (m && m[0].length === e && guard(m[0])) return m[0];
  }
  return null;
}

// Apply one pass, threading the shared registry so tokens are stable per call.
function applyPass(text, pass, token, hints) {
  const { re, cat, guard, kind } = pass;

  if (kind === 'bare-name') return applyBareNamePass(text, token);
  if (kind === 'intake-hint') return applyHintPass(text, token, hints);
  if (kind === 'th-clan-surname') return applyClanSurnamePass(text, token);
  if (kind === 'th-gazetteer') return applyGazetteerPass(text, token);
  if (kind === 'th-given-surname') return applyGivenSurnamePass(text, token);
  if (kind === 'th-admin') return applyThAdminPass(text, token);

  // Resumable (not String#replace): the คุณ / ชื่อ shields may consume only part of a match and let
  // the scan resume at a nested anchor. A callback returning a plain string consumes the whole match,
  // which is exactly String#replace's behaviour.
  const view = cat === 'NAME' ? text : asciiView(text);
  return replaceResumable(text, re, (m) => {
    // `seen` is what the regex read (the ASCII view on a non-NAME pass); `match` is the original text, which
    // every return that masks nothing must give back unchanged.
    const [seen, g1, g2, g3] = m;
    const match = text.slice(m.index, m.index + seen.length);
    if (guard && !guard(seen)) {
      // A loose run can take the next number too (โทร 081-234-5678 2 ครั้ง) and fail its guard as a whole: fall back
      // to the longest shorter match the guard accepts at the same start, so the identifier is still masked.
      const shorter = cat === 'NAME' ? null : longestGuarded(view, re, m.index, seen.length, guard);
      return shorter ? [token(cat, shorter), shorter.length] : match;
    }

    if (cat === 'NAME') {
      if (kind === 'th-nickname' || kind === 'en-nickname') {
        // Nickname label + nickname. The label word (ชื่อเล่น / nickname) is
        // NOT clinical and is dropped entirely — keeping it would re-expose the
        // ชื่อ prefix to the labelled-name pass. Emit just the token.
        const nick = g1;
        if (MED_SHIELD.has(nick.trim())) return match;
        const tok = token('NAME', nick);
        registerNameAliases(token, nick, tok);
        return tok;
      }
      if (kind === 'th-labelled') {
        // "ชื่อ <given> [นามสกุล <surname> | <bare-surname>]" — fold the given
        // name and surname into ONE referent token so the full identity reads as
        // a single [NAME-n]. The bare surname (g3, no นามสกุล keyword) is only
        // taken when it is not the start of a clinical/verb phrase.
        const given = g1 || '';
        const label = given.length <= SHIELD_MAX_RUN ? scanLabelRun(given) : null;
        if (label && label.action !== 'mask') {
          // ชื่อยา / ชื่อโรค / ชื่อสามัญ … — a thing's name, not a person's, and the whole glued run is
          // list words (scanLabelRun). Consume only "ชื่อ" + the run (or the run up to a nested ชื่อ /
          // คุณ) and resume there, so a following real label or bare surname slot is scanned afresh.
          const lead = /^ชื่อ\s*/.exec(match)[0];
          const used = lead.length + (label.action === 'resume' ? label.at : given.length);
          return [match.slice(0, used), used];
        }
        // A 'mask' verdict for a label run is always at 0 (labels are never anchors): the master path.
        let surname = g2 || '';
        let trailing = ''; // text we matched but must put back (shielded surname)
        if (!surname && g3) {
          if (isClinicalRun(g3)) {
            trailing = ' ' + g3; // not a surname — restore it verbatim
          } else {
            surname = g3;
          }
        }
        const surface = (given + ' ' + surname).trim();
        const tok = token('NAME', surface);
        registerNameAliases(token, surface, tok);
        return 'ชื่อ ' + tok + trailing;
      }
      if (kind === 'th-surname') {
        // Standalone "นามสกุล <surname>" — keep the explicit label, mask the surname token. The keyword
        // is unambiguous (unlike a bare space-separated token), so no clinical-lead shield is needed.
        const surname = g1;
        if (MED_SHIELD.has(surname.trim())) return match;
        const tok = token('NAME', surname);
        registerNameAliases(token, surname, tok);
        return 'นามสกุล ' + tok;
      }
      if (kind === 'th-title') {
        // Title + given name. Preserve the honorific (it can carry a clinical
        // role, e.g. นพ. = doctor) and mask only the given-name token.
        const title = g1;
        const given = g2;
        if (MED_SHIELD.has(given.trim())) return match;
        if (title === 'คุณ' && given.length <= SHIELD_MAX_RUN) {
          // คุณ is also "you", part of ขอบคุณ / คุณภาพ, and a prefix to role words (คุณหมอ).
          // scanKhunRun lets the run through only when every character is a list word; otherwise it
          // masks from the last anchor (คุณหมอ|…) — or the whole run, exactly as master.
          const verdict = scanKhunRun(given);
          const ws = match.slice(title.length, match.length - given.length);
          if (verdict.action === 'survive') return match;
          if (verdict.action === 'resume') {
            const used = title.length + ws.length + verdict.at; // >= 3: always makes progress
            return [match.slice(0, used), used];
          }
          if (verdict.at > 0) {
            const rest = given.slice(verdict.at);
            const restTok = token('NAME', rest);
            registerNameAliases(token, rest, restTok);
            return title + ws + given.slice(0, verdict.at) + restTok;
          }
        }
        const tok = token('NAME', given);
        registerNameAliases(token, given, tok);
        // Thai titles glue to the name (นาย+สมชาย), no separating space.
        return title + tok;
      }
      // en-title: preserve the honorific, mask the (1-2 token) name group.
      const title = g1;
      const nameTokens = g2;
      if (MED_SHIELD.has(nameTokens.trim())) return match;
      const tok = token('NAME', nameTokens);
      registerNameAliases(token, nameTokens, tok);
      return title + ' ' + tok;
    }

    return token(cat, seen); // keyed by the ASCII view: both scripts of one number share a token
  }, view);
}

// Mask one string. If a registry is provided, tokens stay stable across all
// strings sharing it (used by stripHistoryPii so coreference survives a whole
// outbound call). Without one, each call gets a fresh, internally-stable map.
// `hints` are KNOWN PII strings (from the structured patient intake) to scrub deterministically — see
// deriveHintTokens. They default to [] so every existing caller is unaffected.
function stripPii(text, registry, hints = []) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const token = registry || makeRegistry();
  // Zero-width characters split a word for the regexes without changing what a reader sees
  // ("นายสมชาย\u200Bใจดี"); they carry nothing clinical, so they go first.
  const input = text.replace(ZERO_WIDTH_RE, '').replace(SURNAME_MARK_RE, '');
  return PASSES.reduce((t, pass) => applyPass(t, pass, token, hints), input).replace(SURNAME_MARK_RE, '');
}

// Mask every message in a history/transcript array under ONE shared registry,
// so the same person/phone/etc. gets the same token across turns. A caller that wants the reverse
// map can pass its own `registry` (via makeRegistry()) and read `registry.entries()` afterward.
// The registry is primed from the whole history first (#238), so a name part that a LATER turn reveals is
// already an alias when an earlier turn is masked for real.
function stripHistoryPii(history, hints = [], registry = makeRegistry()) {
  primeRegistry(history.map((msg) => msg.content), registry, hints);
  return history.map(msg => ({ ...msg, content: stripPii(msg.content, registry, hints) }));
}

// Fill `registry` from EVERY text of one outbound call (chief complaint, history, current message) before any
// of them is masked for real: every surname found anywhere then masks every other mention, whatever the
// order. A surname can expose another ("ทองคำ" | "ใจดี ทองคำ" | "นายสมชาย ใจดี": ใจดี is found in the last
// text, then ทองคำ next to it), so the texts are run again until a round adds nothing; outputs are thrown
// away. Texts run in the given order, so token numbering is unchanged (prefix-stable). Each round is linear;
// past SURNAME_MAX_ROUNDS it throws (fail closed).
function primeRegistry(texts, registry, hints = []) {
  let before = -1;
  for (let round = 0; round < SURNAME_MAX_ROUNDS; round++) {
    for (const t of texts) stripPii(t, registry, hints);
    const after = registry.size();
    if (after === before) return registry;
    before = after;
  }
  throw new Error('PII filter: surname search did not settle');
}

// The identifier labels of a booth typed answer (maskLabelledTail). English matches in any case, with the words of a
// label joined by anything or nothing ("last name", "lastname", "sub-district"); where in a word, see enLabel. A Thai label matches
// anywhere except right after a leading vowel, so เชื่อ ("believe") is not ชื่อ.
const BOOTH_ID_LABELS = {
  en: ['name', 'first name', 'last name', 'family name', 'surname', 'patient name', 'mr', 'mrs', 'ms', 'miss', 'hn',
    'hospital number', 'hospital no', 'mrn', 'id', 'id number', 'national id', 'citizen id', 'passport', 'phone', 'tel',
    'telephone', 'mobile', 'address', 'village', 'sub district', 'district', 'province', 'date of birth',
    'dob', 'born'],
  th: ['ชื่อ', 'ชื่อผู้ป่วย', 'นามสกุล', 'นาย', 'นาง', 'นางสาว', 'เด็กชาย', 'เด็กหญิง', 'ด.ช.', 'ด.ญ.', 'เลข HN',
    'เลขบัตรประชาชน', 'บัตรประชาชน', 'เบอร์', 'โทร', 'ที่อยู่', 'บ้านเลขที่', 'หมู่ที่', 'หมู่บ้าน', 'ตำบล', 'อำเภอ', 'จังหวัด', 'วันเกิด'],
};
// โทร also opens drug names in booth answers (อะโทรปีน, โทรโปนิน, อะซิโทรมัยซิน): there it is a label only when no Thai
// letter but the ศ of โทรศัพท์ follows.
const TH_LABEL_GUARDS = { โทร: '(?!(?!ศ)[ก-ฮเ-ไ])' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLength = (a, b) => b.length - a.length;
// Fail closed on how a label is written: plural, glued to the value or inside a word ("Names:", "fullname",
// "NameDalton"), so these labels match anywhere in any case. The short ones, and those inside common clinical words
// (miss in admission, born in newborn, hospital no in "hospital now"), match only at a word start, then take a
// plural (s, es) and stop before a lowercase letter: "MrDalton", "IDs" and "Misses" count, "MRI" counts too
// (over-mask), "idea", "dobutamine" and "mobilise" do not.
const EN_WORD_START_LABELS = new Set(['mr', 'mrs', 'ms', 'miss', 'hn', 'mrn', 'id', 'tel', 'dob', 'born', 'phone', 'mobile',
  'hospital no']);
const anyCase = (s) => s.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const enLabel = (l) => {
  const words = l.split(' ').map((w) => anyCase(escapeRe(w))).join('[^A-Za-z]{0,3}');
  return EN_WORD_START_LABELS.has(l) ? `(?<![A-Za-z])${words}(?:[Ee]?[Ss])?(?![a-z])` : words;
};
const BOOTH_LABEL_RES = [
  new RegExp(`(?:${[...BOOTH_ID_LABELS.en].sort(byLength).map(enLabel).join('|')})`),
  new RegExp(`(?<![เแโใไ])(?:${[...BOOTH_ID_LABELS.th].sort(byLength).map((l) => l.split(' ').map(escapeRe).join('\\s{0,3}') + (TH_LABEL_GUARDS[l] ?? '')).join('|')})`),
  // The admission number: never the article "an".
  /(?<![A-Za-z])AN(?=[\s:#.-]{0,3}\d)/,
];

// Booth typed answers only (routes/chat.js), never in PASSES: on PLE chat these words are clinical prose ("name the
// cause", "address hypoxia first"). A value typed after a label has no end a rule can find (each value-extent rule
// tried in #422 leaked the next shape), so everything from the first label to the end of the answer becomes ONE token
// of `registry`, fail closed. The token is not a NAME and registers no alias, so no part of the value is masked, or
// learnt, anywhere else in the call.
function maskLabelledTail(answer, registry) {
  const text = answer.replace(ZERO_WIDTH_RE, '');
  const starts = BOOTH_LABEL_RES.map((re) => text.search(re)).filter((i) => i >= 0);
  if (starts.length === 0) return text;
  const at = Math.min(...starts);
  return `${text.slice(0, at)}${registry('PII', text.slice(at))}`;
}

module.exports = { stripPii, stripHistoryPii, primeRegistry, deriveHintTokens, makeRegistry, maskLabelledTail };
