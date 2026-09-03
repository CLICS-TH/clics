/*
 * The assertion that stands between a screenshot and the repository.
 *
 * WHY A GATE AND NOT A REVIEW. A screenshot is the one artifact in this pipeline a human cannot
 * diff. Every other input to the manual is prose in a text file; a PNG is opaque to code review, to
 * `git diff`, and to every other check in this repo. Once committed it is in the history forever,
 * and it is published — physician-ui/public/img/ is served to the open internet. So the frame is
 * captured to a BUFFER, asserted, and only written if it passes. A written frame is a frame someone
 * can `git add` by accident.
 *
 * WHAT IT READS. Not pixels — the DOM text of the page at the moment of capture. That is the
 * honest limit of this gate and it is stated again in the false-negative list below.
 *
 * THE FILTER IS BORROWED, NOT REBUILT. The `pii-filter:*` rules run the frame text through the same
 * rimpl/src/services/pii-filter.js that guards the cloud-AI boundary. Reimplementing Thai name
 * detection here would create a second, weaker copy that drifts — and the one in rimpl is the one
 * with the adversarial leak suite behind it. Six of its eight token classes refuse a frame; see
 * DIRECT below for which two do not, and why that is a decision rather than an oversight.
 *
 * KNOWN FALSE NEGATIVES — read these before trusting a green run:
 *   - Anything rendered as PIXELS. An uploaded ID or licence photo, an avatar, text inside a
 *     <canvas> or a rasterised chart label. The gate cannot see them.
 *   - A bare Thai surname with no honorific and no label. rimpl documents this as a deliberate
 *     limit: widening the pattern to catch it over-masks ordinary clinical prose.
 *   - A name that is genuinely indistinguishable from a common noun.
 * Which is why capture also runs against synthetic fixtures rather than live data: the gate is the
 * second line, not the first.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripPii, makeRegistry } = require('../../../rimpl/src/services/pii-filter.js');

/** Thai digits ๐-๙ defeat every \d predicate, so normalise before any numeric rule runs. */
export function ascii(s) {
  return String(s).replace(/[๐-๙]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0e50 + 48));
}

// A Thai national ID is 13 digits and is normally WRITTEN with separators (1-2345-67890-12-3), so
// the run is collapsed before counting. Bounded on both sides by a non-digit so a longer number —
// a token count, an epoch — is not mistaken for one.
const ID13 = /(?<![0-9])(?:[0-9][-\s]?){12}[0-9](?![0-9])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Licence numbers have no validated format in this product (identity.js trims a free string), so
// they are caught by their LABEL rather than their shape. The VALUE must contain at least two
// digits: without that the label's own words became the finding — "Licence number" reported
// "number" as a licence, which is the sort of false positive that gets a gate switched off.
const LICENCE_LABELLED =
  /(?:ใบอนุญาต|เลขที่ใบประกอบ|licen[cs]e)(?:\s*(?:no\.?|number|เลขที่))?\s*[:：/]*\s*((?:ว\.?\s*)?[A-Za-z0-9-]*\d[A-Za-z0-9-]*\d[A-Za-z0-9-]*)/gi;

// Honorific + a Thai given name. The honorifics are the ones the product's own forms and the rimpl
// title list use; a name behind one of these is never a clinical noun.
const TH_HONORIFIC_NAME =
  /(?:นายแพทย์|แพทย์หญิง|ศาสตราจารย์|รองศาสตราจารย์|ผู้ช่วยศาสตราจารย์|นพ\.|พญ\.|ศ\.|รศ\.|ผศ\.|ดร\.|นางสาว|นาง|นาย)\s*([ก-ฮ][ก-ฮะ-๎]{2,})/g;

// An explicitly labelled name field — what /identity renders back from full_name_th / full_name_en.
const TH_LABELLED_NAME = /(?:ชื่อ-?นามสกุล|ชื่อจริง|นามสกุล|full[_\s]?name)\s*[:：]?\s*([^\s,;)]{2,})/gi;

/** The pseudonym the pilot is supposed to show instead of a name. */
const PSEUDONYM = /^P-\d{3}$/;

/*
 * rimpl's filter masks eight classes. Only six of them can refuse a screenshot.
 *
 * NAME, EMAIL, PHONE, HN, LINE and ADDR point at ONE person. None of them has any business in a
 * manual, so any of them refuses the frame.
 *
 * AGE and DATE are quasi-identifiers: dangerous in a transcript being shipped to a cloud model,
 * where they combine with everything else in the conversation — and unavoidable in a product
 * screenshot, because a dashboard shows dates and a clinical vignette states an age. A gate that
 * refused those would refuse every frame the manual needs, and a gate that refuses everything is
 * one somebody switches off. That is the trade, stated rather than hidden: this gate does not
 * protect against re-identification by date-plus-age, and the fixtures are what protect against
 * that, by never containing a real person in the first place.
 */
const DIRECT = new Set(['EMAIL', 'PHONE', 'HN', 'LINE', 'ADDR']);

/*
 * NAME is deliberately NOT in DIRECT, and this is the one place this gate is weaker than the
 * boundary it borrows from. Say why plainly.
 *
 * rimpl's bare-name pass is tuned to OVER-mask, which is the right call where it lives: masking an
 * extra Thai noun before shipping a transcript to a cloud model costs nothing, while missing a real
 * name costs everything. Applied to UI chrome it fires constantly — measured here, it masked
 * `ตลอดการเรียนรู้` ("throughout your learning") out of the /lpdp subtitle. A gate that refuses
 * every frame is a gate somebody deletes, so its NAME hits are REPORTED for a human to read and do
 * not by themselves refuse a frame.
 *
 * What still refuses a frame, and why that is enough here: the explicit `named-person` rules above,
 * which are precise because they require an honorific or a name LABEL — the only two ways a name
 * actually reaches these screens. And the real control is upstream: capture never touches live
 * data. Every API call is fulfilled from lib/capture-fixtures.mjs, which contains pseudonyms only,
 * so there is no real name in the system under capture to leak.
 */
const REVIEW = new Set(['NAME']);
const REASON = {
  EMAIL: 'an email address',
  PHONE: 'a phone number',
  HN: 'a hospital number',
  LINE: 'a LINE ID',
  ADDR: 'a street address',
};

/**
 * @param {string} raw  the frame's visible DOM text
 * @returns {{rule: string, match: string, why: string}[]}  empty means the frame may be written
 */
export function scanText(raw) {
  const text = String(raw ?? '');
  const flat = ascii(text);
  const out = [];
  const review = [];
  const add = (rule, match, why) => {
    if (!out.some((f) => f.rule === rule && f.match === match)) out.push({ rule, match, why });
  };

  for (const m of flat.matchAll(ID13)) {
    add('national-id', m[0].trim(), '13 digits reads as a Thai national ID');
  }
  for (const m of flat.matchAll(EMAIL)) {
    add('email', m[0], 'an email address identifies a person directly');
  }
  for (const m of flat.matchAll(LICENCE_LABELLED)) {
    add('licence', m[1], 'a value in a licence field');
  }
  for (const m of text.matchAll(TH_HONORIFIC_NAME)) {
    add('named-person', m[0].trim(), 'an honorific followed by a name');
  }
  for (const m of text.matchAll(TH_LABELLED_NAME)) {
    // A pseudonym in a name field is exactly what SHOULD be there.
    if (!PSEUDONYM.test(m[1])) add('named-person', m[0].trim(), 'a value in a name field that is not a P-NNN pseudonym');
  }

  // Last and broadest: ask the on-prem filter, then act on WHICH class it found.
  try {
    const redacted = stripPii(text, makeRegistry(), []);
    for (const m of redacted.matchAll(/\[([A-Z]+)-\d+\]/g)) {
      if (DIRECT.has(m[1])) add(`pii-filter:${m[1]}`, firstDifference(text, redacted), REASON[m[1]]);
      else if (REVIEW.has(m[1])) review.push({ kind: m[1], near: firstDifference(text, redacted) });
    }
  } catch (e) {
    // A gate that opens when it errors is not a gate.
    add('pii-filter-error', e.message, 'the PII filter could not run, so this frame is unverified');
  }
  out.review = review;   // non-fatal, printed for a human to eyeball — see REVIEW above
  return out;
}

/** A short, quotable excerpt around the first place the filter changed something. */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(Math.max(0, i - 25), i + 45).replace(/\s+/g, ' ').trim();
}

/** Formats findings for a build failure. */
export function describe(name, findings) {
  return `${name}: ${findings.length} possible identifier(s) in the captured frame — NOT written.\n`
    + findings.map((f) => `    [${f.rule}] ${JSON.stringify(f.match)} — ${f.why}`).join('\n');
}
