// Question bank loader + validator for the tutor-reply audit.
//
// The bank (scripts/quality/bank/*.json) is SYNTHETIC: every case, name, HN, phone number and ID in
// it was invented for this harness. Nothing in it may ever be replaced with a real PLE turn — real
// turns belong to physicians and go nowhere near a committed file.
//
// Item shape (see docs/QUALITY-GATES.md §Bank):
//   id                 kebab-case, unique across all files
//   mode               natural | examiner | rescue
//   language           th | en | mixed      (mixed = Thai prose with English clinical terms)
//   specialty          free text, e.g. "cardiology"
//   chief_complaint    optional; chat.js prepends it to the newest turn
//   patient_ref        optional synthetic identifier; chat.js derives PII hint tokens from it
//   turns              [{role: physician|assistant, content}], alternating, physician first AND last.
//                      The last turn is the `message`; the rest is the chat route's `history`.
//   categories         tags, e.g. ["diagnosis", "thai-context"]
//   adversarial        null, or {type, expected_behaviour}
//   key_facts          what a correct reply must get right — only facts the author is certain of
//   must_not           what a reply must not do or say
//   sources            the real guideline(s)/papers the key facts rest on
//   identifiers        (pii_echo items) synthetic identifiers a reply must not repeat
//   must_not_patterns  optional regex sources; a match in the reply is a deterministic critical flag

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { thaiShare, RESCUE_AFTER_EXCHANGES } from './rimpl.mjs';

export const QUALITY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BANK_DIR = path.join(QUALITY_DIR, 'bank');

export const MODES = ['natural', 'examiner', 'rescue'];
export const LANGUAGES = ['th', 'en', 'mixed'];
export const ADVERSARIAL_TYPES = [
  'wrong_premise',        // a false clinical claim the tutor must correct, not adopt
  'sycophancy_pushback',  // the physician insists on an error after being corrected
  'unsafe_dosing',        // a dose or route that would harm
  'pregnancy_dosing',     // teratogenic / pregnancy-contraindicated drug or dose
  'paediatric_dosing',    // child-specific dose or contraindication
  'out_of_scope',         // non-clinical or unethical request
  'fabricate_reference',  // asks the tutor to invent or confirm a non-existent source
  'pii_echo',             // the question carries synthetic patient identifiers
  'language_switch_en',   // English turn after Thai history → reply must be English
  'language_switch_th',   // Thai turn after English history → reply must be Thai
  'prompt_leak',          // asks the tutor to print its instructions
];
// Out-of-scope and prompt-leak items have no clinical guideline to rest on.
const SOURCELESS = new Set(['out_of_scope', 'prompt_leak']);

// The language a bank author claims must match the text, by the same metric the checks apply to
// replies. Thai clinical prose keeps drug and lab names in Latin script, hence th >= 0.5, not 1.0;
// the th|mixed line is the author's call (both expect a Thai reply), so the two ranges overlap.
const LANG_RULE = {
  th: (s) => s >= 0.5,
  en: (s) => s === 0,
  mixed: (s) => s >= 0.3 && s < 0.9,
};

export function validateItem(item) {
  const errs = [];
  const bad = (m) => errs.push(`${item?.id ?? '(no id)'}: ${m}`);
  if (!item || typeof item !== 'object') return ['item is not an object'];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id || '')) bad('id must be kebab-case');
  if (!MODES.includes(item.mode)) bad(`mode must be one of ${MODES.join('|')}`);
  if (!LANGUAGES.includes(item.language)) bad(`language must be one of ${LANGUAGES.join('|')}`);
  if (typeof item.specialty !== 'string' || !item.specialty) bad('specialty required');
  if (item.chief_complaint != null && typeof item.chief_complaint !== 'string') bad('chief_complaint must be a string');

  const turns = item.turns;
  if (!Array.isArray(turns) || !turns.length) {
    bad('turns must be a non-empty array');
  } else {
    turns.forEach((t, i) => {
      const want = i % 2 === 0 ? 'physician' : 'assistant';
      if (t?.role !== want) bad(`turns[${i}].role must be ${want} (alternating, physician first)`);
      if (typeof t?.content !== 'string' || !t.content.trim()) bad(`turns[${i}].content must be non-empty`);
    });
    if (turns[turns.length - 1]?.role !== 'physician') bad('last turn must be the physician (it is the message)');
    const physicianTurns = turns.filter((t) => t?.role === 'physician').length;
    if (item.mode === 'rescue') {
      // Production only rescues after RESCUE_AFTER_EXCHANGES physician turns of HISTORY.
      if (physicianTurns - 1 < RESCUE_AFTER_EXCHANGES) {
        bad(`rescue items need >= ${RESCUE_AFTER_EXCHANGES} physician turns of history (production trigger)`);
      }
    } else if (physicianTurns > 4) {
      bad('non-rescue items have at most 4 physician turns');
    }
    const last = turns[turns.length - 1]?.content ?? '';
    if (LANGUAGES.includes(item.language) && !LANG_RULE[item.language](thaiShare(last))) {
      bad(`final turn's Thai share ${thaiShare(last).toFixed(2)} does not fit language=${item.language}`);
    }
  }

  if (!Array.isArray(item.categories) || !item.categories.length) bad('categories must be a non-empty array');
  const adv = item.adversarial;
  if (adv != null) {
    if (!ADVERSARIAL_TYPES.includes(adv.type)) bad(`adversarial.type must be one of ${ADVERSARIAL_TYPES.join('|')}`);
    if (typeof adv.expected_behaviour !== 'string' || !adv.expected_behaviour) bad('adversarial.expected_behaviour required');
    if (!Array.isArray(item.must_not) || !item.must_not.length) bad('adversarial items need a non-empty must_not');
    if (adv.type === 'pii_echo' && !(Array.isArray(item.identifiers) && item.identifiers.length)) {
      bad('pii_echo items need identifiers');
    }
  }
  if (!Array.isArray(item.key_facts) || !item.key_facts.length) bad('key_facts must be a non-empty array');
  if (!Array.isArray(item.must_not)) bad('must_not must be an array');
  if (!Array.isArray(item.sources)) bad('sources must be an array');
  else if (!item.sources.length && !SOURCELESS.has(adv?.type)) bad('sources must name the guideline the key facts rest on');
  for (const re of item.must_not_patterns ?? []) {
    try { new RegExp(re, 'iu'); } catch (e) { bad(`must_not_patterns: invalid regex ${JSON.stringify(re)}: ${e.message}`); }
  }
  return errs;
}

/** Load every bank file, validate, and return {items, files, sha}. Throws on ANY invalid item or a
 *  duplicate id — a half-valid bank silently measures something other than what was pre-registered. */
export async function loadBank(dir = BANK_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no bank files in ${dir}`);
  const items = [];
  const hash = createHash('sha256');
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    hash.update(f).update('\0').update(raw).update('\0');
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${f}: invalid JSON: ${e.message}`); }
    if (!Array.isArray(doc.items)) throw new Error(`${f}: expected {"items": [...]}`);
    for (const it of doc.items) items.push({ ...it, _file: f });
  }
  const errors = items.flatMap(validateItem);
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.id)) errors.push(`${it.id}: duplicate id (${seen.get(it.id)} and ${it._file})`);
    seen.set(it.id, it._file);
  }
  if (errors.length) throw new Error(`bank invalid:\n  ${errors.join('\n  ')}`);
  return { items, files, sha: `bank-${hash.digest('hex').slice(0, 12)}` };
}

/** Narrow a bank by --ids (comma list, exact) then --limit (first n, file order). */
export function selectItems(items, { ids, limit } = {}) {
  let out = items;
  if (ids && ids.length) {
    const want = new Set(ids);
    const missing = [...want].filter((id) => !items.some((it) => it.id === id));
    if (missing.length) throw new Error(`unknown item id(s): ${missing.join(', ')}`);
    out = out.filter((it) => want.has(it.id));
  }
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

/** Composition counts — what the final report and the docs table are built from. */
export function composition(items) {
  const count = (key) => items.reduce((m, it) => {
    const k = typeof key === 'function' ? key(it) : it[key];
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  return {
    total: items.length,
    language: count('language'),
    mode: count('mode'),
    specialty: count('specialty'),
    adversarial: count((it) => it.adversarial?.type ?? 'none'),
    multiTurn: items.filter((it) => it.turns.length > 1).length,
  };
}
