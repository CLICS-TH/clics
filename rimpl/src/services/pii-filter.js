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
const { TH_GIVEN_NAMES, TH_SURNAMES } = require('./pii-names.th');

function makeRegistry() {
  const counters = Object.create(null); // category -> next index
  const seen = Object.create(null);     // category -> { surfaceForm -> token }
  const aliases = Object.create(null);  // category -> { alias -> token }

  function ensure(category) {
    if (!seen[category]) {
      seen[category] = Object.create(null);
      aliases[category] = Object.create(null);
      counters[category] = 0;
    }
  }

  function token(category, surfaceForm) {
    ensure(category);
    const key = surfaceForm.trim();
    if (seen[category][key] === undefined) {
      // Reuse a token already bound to one of this surface form's parts.
      const existing = aliases[category][key];
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

  // Snapshot of all NAME aliases currently known (used to catch bare names).
  function knownAliases(category) {
    ensure(category);
    return aliases[category];
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
  token.knownAliases = knownAliases;
  token.entries = entries;
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
  for (const raw of patientRef.split(/\s+/)) {
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
// Thai: title then a SINGLE following name token (the given name). We do NOT
// grab a second space-separated Thai token as a "surname": Thai compounds words
// without spaces, so the token after a name is just as likely a clinical phrase
// ("ปวดท้อง" = abdominal pain, "ตรวจคนไข้" = examined the patient) as a surname,
// and the brief requires symptoms to SURVIVE. An explicit surname is masked via
// the labelled "ชื่อ ... นามสกุล ..." rule. KNOWN GAP: a bare, unlabelled Thai
// surname following a given name is left in clear text; masking the given name
// already de-identifies, and over-masking clinical phrases is the worse error.
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
// Thai has no word spaces, so an anchor (คุณ, ชื่อ) is followed by a run that is
// sometimes a name and sometimes ordinary prose: ขอบคุณครับ ("thank you"),
// คุณหมอ ("doctor", a form of address), คุณภาพ ("quality"), คุณคิดว่า ("you
// think that"), ชื่อยา ("drug name"). The shields below are CLOSED word lists:
// a run is let through ONLY when it is wholly accounted for by them; anything
// unknown is still masked exactly as before. So every miss of these lists fails
// CLOSED (over-masks), never open. Each entry was checked not to begin a common
// Thai given name — e.g. มา / มี are deliberately ABSENT (มานี, มาลี, มีนา), and
// short particles that could begin a name (คะ → คะนอง) only count when nothing
// unknown follows them (see splitKhunRun).
// ---------------------------------------------------------------------------

// Words that can follow คุณ (pronoun "you") or a non-name ชื่อ label and that
// never begin a Thai given name. Once one of these starts the remainder, the
// remainder is a phrase, not a name.
const TH_NON_NAME_LEADS = [
  'ที่', 'ว่า', 'คือ', 'ของ', 'บอก', 'แจ้ง', 'ให้', 'ได้', 'ไม่', 'ก็', 'จะ', 'ช่วย',
  'และ', 'หรือ', 'เป็น', 'สำหรับ', 'ล่วงหน้า', 'นี้', 'นั้น', 'อะไร', 'ซึ่ง', 'ถาม',
  'ตอบ', 'คิด', 'ตรวจ', 'ควร', 'เคย', 'สามารถ', 'อยาก', 'ลอง', 'ทราบ', 'รู้',
  'เห็น', 'พิจารณา', 'วินิจฉัย', 'สั่ง', 'กำลัง', 'เลือก', 'ใช้', 'ระบุ', 'อธิบาย',
];
// NOT here on purpose: มา / มี (มานี, มาลี, มีนา) and ต้อง ("must", but also a common nickname —
// คุณต้อง). Adding a lead that can begin a name or nickname would open a leak.
// คุณ + one of these is ONE word (คุณภาพ = quality, คุณค่า = value, …), never a title + name.
// คุณสมบัติ (property) is deliberately absent: สมบัติ is also a given name (pii-names.th.js), so
// "คุณสมบัติ" stays masked — the ambiguity is resolved toward masking.
const TH_KHUN_COMPOUNDS = ['ภาพ', 'ค่า', 'ลักษณะ', 'ประโยชน์', 'ูปการ'];
// Role / kinship forms of address after คุณ (คุณหมอ, คุณแม่). They are not names, but a real name may
// FOLLOW them (คุณหมอสมชาย) — so they are kept and whatever unknown run follows is still masked.
// Short kin words that begin given names (ตา → ตาล, อา → อารีย์ / อานนท์, น้า) are deliberately absent.
const TH_ADDRESS_TERMS = [
  'หมอ', 'พยาบาล', 'เภสัชกร', 'อาจารย์', 'แม่', 'พ่อ', 'ป้า', 'ลุง', 'ยาย', 'ปู่', 'ย่า', 'พี่', 'ญาติ',
];
// Polite particles / closings (ขอบคุณครับ, ขอบคุณมากค่ะ). Some could begin a name (คะ, นะ, มาก), so a
// particle only counts when the run ENDS after it or another listed word follows it.
const TH_PARTICLES = ['ครับ', 'ค่ะ', 'คะ', 'คับ', 'จ้ะ', 'จ้า', 'นะ', 'มาก', 'ผม', 'ดิฉัน'];
// ชื่อ + one of these labels a THING (drug, disease, generic / trade name, organism, topic), not a person.
const TH_LABEL_NON_NAME = ['ยา', 'โรค', 'สามัญ', 'การค้า', 'ทางการค้า', 'เชื้อ', 'วิทยาศาสตร์', 'เรื่อง'];

// Longest entry of `list` that `s` contains at `pos`, or ''.
function wordAt(s, pos, list) {
  let best = '';
  for (const w of list) {
    if (w.length > best.length && s.startsWith(w, pos)) best = w;
  }
  return best;
}

// Classify the Thai run that follows a คุณ anchor. Returns { keep, then }:
//   keep  — how many leading chars of the run are NOT a name (kept verbatim)
//   then  — 'recurse': the rest is prose; re-scan it for titles (a nested "คุณสมศรี" is still caught)
//           'mask':    the rest (from `keep`) is treated as a name and masked
// keep === 0 && then === 'mask' is the original behaviour (the whole run is the name).
function splitKhunRun(run) {
  const compound = wordAt(run, 0, TH_KHUN_COMPOUNDS);
  if (compound) return { keep: compound.length, then: 'recurse' };
  let pos = 0;
  let particlesFrom = -1; // start of a trailing run of particles, if any
  while (pos < run.length) {
    if (pos > 0 && run.startsWith('คุณ', pos)) return { keep: pos, then: 'recurse' };
    if (wordAt(run, pos, TH_NON_NAME_LEADS)) return { keep: pos, then: 'recurse' };
    const address = wordAt(run, pos, TH_ADDRESS_TERMS);
    if (address) { pos += address.length; particlesFrom = -1; continue; }
    const particle = wordAt(run, pos, TH_PARTICLES);
    if (particle) { if (particlesFrom < 0) particlesFrom = pos; pos += particle.length; continue; }
    break; // an unknown segment — possibly a name
  }
  if (pos === run.length) return { keep: pos, then: 'recurse' };
  // Unknown content right after a particle: the "particle" may be the start of a name (คะนอง) — undo it.
  if (particlesFrom >= 0) pos = particlesFrom;
  return { keep: pos, then: 'mask' };
}

// Is the run after a ชื่อ label a thing-label (ชื่อยา, ชื่อโรคนี้, ชื่อสามัญ) rather than a person's name?
// Only when the label word is followed by nothing, another label word, or a non-name lead — so a name
// that merely begins with a label word (ชื่อยาใจ) is still masked. Returns the label word (to keep
// verbatim) or ''. The caller re-scans everything AFTER the label word, because the glued run can
// itself contain a real label ("ชื่อยาที่ผู้ป่วยชื่อสมชายได้รับ").
function nonNameLabel(run) {
  const w = wordAt(run, 0, TH_LABEL_NON_NAME);
  if (!w) return '';
  const rest = run.slice(w.length);
  const ok = rest === '' || !!wordAt(rest, 0, TH_LABEL_NON_NAME) || !!wordAt(rest, 0, TH_NON_NAME_LEADS);
  return ok ? w : '';
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
// The optional bare-surname group is shielded by startsWithClinicalLead at
// substitution time. Surname token(s) fold into the same [NAME-n] referent.
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
//   - (?<!ต่าง|ทุก|หลาย|แต่ละ): ต่างจังหวัด ("up-country"), ทุกอำเภอ, หลายตำบล are generic.
//   - รพ.สต. (sub-district health-promoting hospital) is matched as ONE keyword. Before, its inner
//     "ต." was read as ตำบล and the label was corrupted to "รพ.ส[ADDR-n]". Now the label survives and
//     only a following place name (the village / tambon the facility is named after) is masked.
//   - After จังหวัด / จ. / รพ.สต. a following word that is a grammatical or clinical lead
//     (รพ.จังหวัด เพื่อ…, ต่อ รพ.สต. และ…) is not a place. For จังหวัด the lead list was checked
//     against all 77 province names (tests/pii-false-positives.test.js re-checks every one).
//     ตำบล/อำเภอ get NO lead list — there are thousands of them and some do begin with a lead
//     (อำเภอจะนะ, ตำบลในเมือง) — so they keep the original, demonstrative-only exclusion.
const TH_ADMIN_RE = /(?<!ต่าง|ทุก|หลาย|แต่ละ)(รพ\.\s?สต\.|สต\.|ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.)(\s*)([ก-ฮะ-๎]+)/g;
const TH_DEMONSTRATIVE_RE = /^(?:นี้|นั้น|ไหน|ใด|เดียวกัน)/;
const TH_PROVINCE_NON_PLACE_LEADS = [
  'เพื่อ', 'ที่', 'และ', 'หรือ', 'ได้', 'ไม่', 'แล้ว', 'จาก', 'ด้วย', 'มา', 'มี', 'เป็น', 'ใกล้เคียง',
  'อื่น', 'ของ', 'ให้', 'ก็', 'จะ', 'ซึ่ง', 'เพราะ', 'ส่ง', 'ตรวจ', 'รักษา', 'ทำ', 'ใน', 'กับ', 'ไป',
  'โดย', 'หลัง', 'ก่อน',
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

  // Thai national ID: 13 digits, with or without the X-XXXX-XXXXX-XX-X dashes.
  {
    re: /\b\d(?:[\s-]?\d){12}\b/g,
    cat: 'ID',
    // Guard: only when the digits actually total 13 (the loose run above could
    // otherwise straddle unrelated numbers separated by spaces).
    guard: (m) => (m.replace(/\D/g, '').length === 13),
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
    re: /\+?66[\s-]?(?:\(0\)[\s-]?)?\d(?:[\s()-]*\d){6,9}/g,
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
    re: /\(?0\d\)?(?:[\s()-]*\d){7,9}/g,
    cat: 'PHONE',
    guard: (m) => {
      const d = m.replace(/\D/g, '').length;
      return d >= 9 && d <= 10;
    },
  },

  // --- Dates (kept stable category so repeated dates collapse) ---
  { re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, cat: 'DATE' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g, cat: 'DATE' },

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
  // guarded by boundary + clinical-lead so clinical phrases survive. Runs LAST among name passes.
  { cat: 'NAME', kind: 'th-gazetteer' },

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
function registerNameAliases(token, surface, tok) {
  for (const part of surface.split(/\s+/)) {
    if (part.length >= 2 && !MED_SHIELD.has(part)) token.alias('NAME', part, tok);
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
  return out;
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
    const h = typeof hint === 'string' ? hint.trim() : '';
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
function applyGazetteerPass(text, token) {
  const names = [...TH_GIVEN_NAMES].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:${alt})`, 'g');
  return text.replace(re, (match, offset, full) => {
    if (MED_SHIELD.has(match)) return match;
    const prev = offset > 0 ? full[offset - 1] : '';
    if (TH_LETTER_RE.test(prev)) return match; // glued into a preceding Thai word — skip (conservative)
    const after = full.slice(offset + match.length);
    const standalone = !after || !TH_LETTER_RE.test(after[0]); // space / punct / non-Thai / end follows
    if (standalone || startsWithClinicalLead(after)) {
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

// Apply one pass, threading the shared registry so tokens are stable per call.
function applyPass(text, pass, token, hints) {
  const { re, cat, guard, kind } = pass;

  if (kind === 'bare-name') return applyBareNamePass(text, token);
  if (kind === 'intake-hint') return applyHintPass(text, token, hints);
  if (kind === 'th-clan-surname') return applyClanSurnamePass(text, token);
  if (kind === 'th-gazetteer') return applyGazetteerPass(text, token);
  if (kind === 'th-admin') return applyThAdminPass(text, token);

  // Re-run THIS pass over a fragment a match swallowed but did not mask (used by the คุณ / ชื่อ
  // shields). A fresh RegExp so the nested scan never shares lastIndex with the outer one.
  const rescan = (fragment) =>
    (fragment ? applyPass(fragment, { ...pass, re: new RegExp(re.source, re.flags) }, token, hints) : fragment);

  re.lastIndex = 0;
  return text.replace(re, (match, g1, g2, g3) => {
    if (guard && !guard(match)) return match;

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
        const label = nonNameLabel(given);
        if (label) {
          // ชื่อยา / ชื่อโรค / ชื่อสามัญ … — a thing's name, not a person's. Keep "ชื่อ" + the label
          // word verbatim and re-scan everything after it (a nested "ชื่อ <real name>" is still masked).
          const head = /^ชื่อ\s*/.exec(match)[0] + label;
          return head + rescan(match.slice(head.length));
        }
        let surname = g2 || '';
        let trailing = ''; // text we matched but must put back (shielded surname)
        if (!surname && g3) {
          if (startsWithClinicalLead(g3)) {
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
        if (title === 'คุณ') {
          // คุณ is also "you", part of ขอบคุณ / คุณภาพ, and a prefix to role words (คุณหมอ).
          // splitKhunRun keeps only what its closed word lists account for; the rest is either
          // re-scanned (prose) or masked (an unknown run — fail closed).
          const { keep, then } = splitKhunRun(given);
          if (then === 'recurse' || keep > 0) {
            const ws = match.slice(title.length, match.length - given.length);
            const kept = given.slice(0, keep);
            const rest = given.slice(keep);
            if (then === 'recurse') return title + ws + kept + rescan(rest);
            const restTok = token('NAME', rest);
            registerNameAliases(token, rest, restTok);
            return title + ws + kept + restTok;
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

    return token(cat, match);
  });
}

// Mask one string. If a registry is provided, tokens stay stable across all
// strings sharing it (used by stripHistoryPii so coreference survives a whole
// outbound call). Without one, each call gets a fresh, internally-stable map.
// `hints` are KNOWN PII strings (from the structured patient intake) to scrub deterministically — see
// deriveHintTokens. They default to [] so every existing caller is unaffected.
function stripPii(text, registry, hints = []) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const token = registry || makeRegistry();
  return PASSES.reduce((t, pass) => applyPass(t, pass, token, hints), text);
}

// Mask every message in a history/transcript array under ONE shared registry,
// so the same person/phone/etc. gets the same token across turns. A caller that wants the reverse
// map can pass its own `registry` (via makeRegistry()) and read `registry.entries()` afterward.
function stripHistoryPii(history, hints = [], registry = makeRegistry()) {
  return history.map(msg => ({ ...msg, content: stripPii(msg.content, registry, hints) }));
}

module.exports = { stripPii, stripHistoryPii, deriveHintTokens, makeRegistry };
