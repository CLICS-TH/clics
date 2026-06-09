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

  token.alias = alias;
  token.knownAliases = knownAliases;
  return token;
}

// Thai honorific titles that lead a personal name.
// นพ. = physician (male), พญ. = physician (female), ด.ช./ด.ญ. = boy/girl child.
const TH_TITLES = ['นพ\\.', 'พญ\\.', 'ด\\.ช\\.', 'ด\\.ญ\\.', 'นางสาว', 'นาง', 'นาย', 'คุณ'];
// English honorifics. Order matters only for the alternation; \. is optional.
const EN_TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'];

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
const TH_LABELLED_RE = new RegExp(
  `ชื่อ\\s*(${TH_NAME})(?:\\s*นามสกุล\\s*(${TH_NAME})|\\s+(${TH_NAME}))?`,
  'g'
);

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
  {
    re: /(?:\bline(?:\s*id)?|ไลน์(?:ไอดี)?)\s*[:：]?\s*@?([A-Za-z0-9._-]{2,})/gi,
    cat: 'LINE',
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
  // No leading \b: it is ASCII-only and never matches before a Thai keyword
  // (ห้อง / หอผู้ป่วย). The keywords are distinctive enough to anchor on alone.
  { re: /(?:ward|ห้อง|หอผู้ป่วย)\s+[A-Za-z0-9]+/gi, cat: 'WARD' },

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
  {
    re: /(?:ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.)\s*([ก-ฮะ-๎]+)/g,
    cat: 'ADDR',
    guard: (m) => {
      // strip the keyword, look at the place token
      const place = m.replace(/^(?:ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.)\s*/, '');
      return !/^(?:นี้|นั้น|ไหน|ใด|เดียวกัน)/.test(place);
    },
  },

  // --- Nicknames (run BEFORE the ชื่อ labelled rule; ชื่อ is its prefix) ---
  { re: TH_NICKNAME_RE, cat: 'NAME', kind: 'th-nickname' },
  { re: EN_NICKNAME_RE, cat: 'NAME', kind: 'en-nickname' },

  // --- Names ---
  // Order: labelled fields, then title-led. Each registers its parts as aliases
  // so the final 'bare-name' pass can catch later standalone occurrences.
  { re: TH_LABELLED_RE, cat: 'NAME', kind: 'th-labelled' },
  { re: TH_NAME_RE, cat: 'NAME', kind: 'th-title' },
  { re: EN_NAME_RE, cat: 'NAME', kind: 'en-title' },
  // Bare occurrences of an already-seen name part (no title), e.g. a transcript
  // that introduces "นพ.สมชาย" then later writes just "สมชาย". Built dynamically
  // from the registry; only fires for names already masked in THIS call.
  { cat: 'NAME', kind: 'bare-name' },

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

// Apply one pass, threading the shared registry so tokens are stable per call.
function applyPass(text, pass, token) {
  const { re, cat, guard, kind } = pass;

  if (kind === 'bare-name') return applyBareNamePass(text, token);

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
      if (kind === 'th-title') {
        // Title + given name. Preserve the honorific (it can carry a clinical
        // role, e.g. นพ. = doctor) and mask only the given-name token.
        const title = g1;
        const given = g2;
        if (MED_SHIELD.has(given.trim())) return match;
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
function stripPii(text, registry) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const token = registry || makeRegistry();
  return PASSES.reduce((t, pass) => applyPass(t, pass, token), text);
}

// Mask every message in a history/transcript array under ONE shared registry,
// so the same person/phone/etc. gets the same token across turns.
function stripHistoryPii(history) {
  const registry = makeRegistry();
  return history.map(msg => ({ ...msg, content: stripPii(msg.content, registry) }));
}

module.exports = { stripPii, stripHistoryPii };
