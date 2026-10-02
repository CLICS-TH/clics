#!/usr/bin/env node
// cite-verify.mjs — are the tutor's (Source, Year) citations REAL?
//
// rimpl's hasCitation() checks only the SHAPE "(something, 1234)". A confidently invented
// "(Fake Guideline, 2023)" passes it, and so did every Gate 0 reply. This script checks the source:
//
//   1. Curated match — scripts/quality/known-sources.json lists real guidelines, statements and
//      landmark trials with their aliases and the edition years we are sure of. A DOCUMENT match with
//      a listed year and NO extra words is `verified`; a document match carrying words that are not
//      that document's ("ESC Guidelines on Garlic … in Heart Failure") is `document-unconfirmed`; a
//      PUBLISHER/series match ("WHO …", "ESC …", "ADA …") is `publisher-only`; a match with an
//      unlisted year is `year-mismatch`.
//   2. Organisation-only names — a name that is just a body ("Endocrine Society", "Centers for
//      Disease Control and Prevention"), or an acronym plus a document-type word ("ACR Guideline",
//      "FDA Boxed Warning") — are `publisher-only` WITHOUT a PubMed lookup. PubMed's title index
//      matches such a name to any paper that mentions the body, which is how 16 of the 45
//      `verified` in the 2026-10-02 baseline came about. A bare uncurated acronym ("AAO") is
//      `unverified`: it cannot be told apart from a trial acronym, and it is not looked up.
//   3. PubMed — anything else is looked up with NCBI E-utilities esearch: the cited name as a quoted
//      [Title] phrase AND the year as [dp], falling back to every title word as [ti]. Both are
//      accepted only when they narrow to <= MAX_HITS papers; more is a topic, not a citation. A hit
//      is `verified`; a hit only without the year is `year-mismatch`; nothing is `unverified`.
//
// THE FIVE LABELS, AND WHAT THEY DO NOT MEAN
//   verified       a real document with this name exists for this year. It does NOT mean the
//                  document says what the reply claims it says — that is the judges' and the
//                  clinician's question (rubric dimension: citation honesty).
//   publisher-only the publisher or series is real and publishes in that year, but the DOCUMENT is
//                  not identified. "(WHO Guideline on Garlic Extract for Hypertension, 2021)" lands
//                  here — the commonest fabrication is a real publisher with an invented title, so
//                  this is NOT verified: it does not count toward the C-1 rate and goes to a human.
//   document-unconfirmed  the name contains a real document's words AND other words that are not
//                  part of that document's title or aliases — "KDIGO Clinical Practice Guideline for
//                  Turmeric in CKD". A real document with an invented topic grafted on. NOT verified;
//                  goes to a human.
//
// KNOWN AND ACCEPTED GAPS (reviewed on PR #113). An ordinary word written in capitals still MATCHES a
// trial acronym ("Sepsis RECOVERY of function"), and a surname next to "trial" still matches its
// entry ("Villanueva trial of garlic"); the leftover-word rule then turns both into
// `document-unconfirmed`, because their other words are not the trial's. What still reads
// `verified` is (a) an invented title built ONLY from the matched document's own vocabulary plus
// generic words, and (b) misattribution — a real document cited for a claim it does not make. No
// string check can see (b); it is the judges' `citation_honesty` and the clinician's job.
//   year-mismatch  the source is real but we hold no edition for that year. Our edition lists are
//                  deliberately incomplete (only years we are certain of), so this may be our gap.
//   unverified     we could not confirm it. NOT "fabricated": Thai-language sources are not in
//                  PubMed, author-year citations name no title, and a paraphrased title misses a
//                  phrase search. Every unverified citation goes to a human.
//
// Network: E-utilities only, ≤3 requests/s (NCBI's no-API-key limit), no API key, no email, and the
// only thing sent is the cited name and year — model output to SYNTHETIC questions, never patient
// data. Results are cached (scripts/quality/cache/pubmed.json) so a re-run costs nothing. Every
// network edge is injectable (fetchImpl, sleep, now) so the tests run offline.
//
// Usage:
//   node scripts/quality/cite-verify.mjs scripts/quality/report/<label>.json [--offline] [--cache <file>]
//   → writes scripts/quality/report/<label>.cites.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractReferences } from './rimpl.mjs';
import { QUALITY_DIR } from './bank.mjs';
import { wilson, fmtRate } from './stats.mjs';

export const KNOWN_SOURCES_FILE = path.join(QUALITY_DIR, 'known-sources.json');
export const DEFAULT_CACHE = path.join(QUALITY_DIR, 'cache', 'pubmed.json');
export const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
export const STATUSES = ['verified', 'document-unconfirmed', 'publisher-only', 'year-mismatch', 'unverified'];
const CURRENT_YEAR = new Date().getUTCFullYear();

/* ---------------------------------------------------------------- parsing */

const THAI_RE = /[฀-๿]/;

/** One extracted reference source ("ADA Standards of Care, 2024" — possibly several joined by ';')
 *  → [{raw, name, year, yearCE, era}]. Buddhist-Era years (> 2400) are converted (−543): Thai
 *  guidelines are titled by BE year, and a model writing (…, 2566) is citing 2023, not inventing. */
export function parseCitations(source) {
  return String(source).split(/;/).map((part) => part.trim()).filter(Boolean).map((raw) => {
    const m = raw.match(/^(.*),\s*(\d{4})(?!.*,\s*\d{4})/s);
    if (!m) return { raw, name: raw, year: null, yearCE: null, era: null };
    const name = m[1].trim();
    const year = Number(m[2]);
    const era = year > 2400 ? 'BE' : 'CE';
    return { raw, name, year, yearCE: era === 'BE' ? year - 543 : year, era };
  });
}

const STOP = new Set(['the', 'of', 'for', 'and', 'on', 'in', 'a', 'an', 'to', 'with', 'guideline', 'guidelines',
  'guidance', 'recommendation', 'recommendations', 'statement', 'et', 'al', 'update', 'updated', 'focused',
  'report', 'clinical', 'practice', 'trial', 'study', 'investigators', 'group', 'edition', 'ed', 'version']);

export function normalize(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}฀-๿]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const tokens = (s) => normalize(s).split(' ').filter((t) => t && !STOP.has(t));

/** Tokens in their ORIGINAL case (NFKC, split on anything that is not a letter or digit). */
const rawTokens = (s) => String(s).normalize('NFKC').replace(/&/g, ' and ').split(/[^\p{L}\p{N}\u0E00-\u0E7F]+/u).filter(Boolean);
/** An acronym-like token: two or more capitals ("WHO", "ESC", "NG28", "ProCESS", "RE"). These match
 *  CASE-SENSITIVELY — otherwise the English word "who" is the WHO and "reduce" is the REDUCE trial. */
const isAcronym = (t) => (t.match(/\p{Lu}/gu) || []).length >= 2;
const isAllCaps = (t) => /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t);

/* --------------------------------------------------------- curated match */

/**
 * Does one Latin alias match the cited name? Every significant alias token must be a whole token of
 * the name — acronym tokens case-sensitively, ordinary words case-insensitively. A ONE-token alias
 * is the dangerous case (a surname like "Sort", or a trial acronym that is also a word, like
 * "RECOVERY"), so it needs more:
 *   - an acronym alias must appear exactly as written (case-sensitive, above). For a TRIAL entry
 *     that is the "all-caps or next to 'trial'" rule: an exact match of a token with two or more
 *     capitals ("RECOVERY", "ProCESS") is acronym-shaped by construction, which an ordinary word
 *     at the start of a sentence ("Recovery", "Reduce") never is. The check below states it anyway,
 *     so a future change to isAcronym cannot silently drop it;
 *   - a plain-word alias (a surname) must be the whole name ("Villanueva", "Villanueva et al.") or
 *     stand next to the word "trial".
 */
function latinAliasMatches(alias, entry, name) {
  const aliasToks = rawTokens(alias).filter((t) => !STOP.has(t.toLowerCase()));
  if (!aliasToks.length) return 0;
  const raw = rawTokens(name);
  const lower = raw.map((t) => t.toLowerCase());
  const positions = (t) => raw.flatMap((r, i) => ((isAcronym(t) ? r === t : lower[i] === t.toLowerCase()) ? [i] : []));
  if (!aliasToks.every((t) => positions(t).length)) return 0;
  if (aliasToks.length === 1) {
    const t = aliasToks[0];
    const nextToTrial = positions(t).some((i) => lower[i - 1] === 'trial' || lower[i + 1] === 'trial');
    if (isAcronym(t)) {
      if (entry.kind === 'trial' && !nextToTrial) {
        if (!positions(t).some((i) => isAllCaps(raw[i]) || isAcronym(raw[i]))) return 0;
        // A title in ALL CAPS makes every word look like an acronym ("HIGH-DOSE VITAMINS CURE…").
        // There the acronym must be the whole name, not one capitalised word among many.
        const words = raw.filter((r) => /\p{L}/u.test(r) && !STOP.has(r.toLowerCase()));
        if (words.length > 1 && words.every(isAllCaps)) return 0;
      }
    } else {
      const wholeName = /^\s*[\p{L}'’-]+(?:\s+et\.?\s+al\.?)?\s*$/u.test(name.trim()) && lower[0] === t.toLowerCase();
      if (!wholeName && !nextToTrial) return 0;
    }
  }
  return aliasToks.length;
}

/** Best curated entry for a cited name, or null. Thai aliases (no word spaces) match as substrings;
 *  Latin aliases per latinAliasMatches. The most specific alias wins; on a tie, a document beats a
 *  family. */
export function matchKnown(name, known) {
  const nameNorm = normalize(name);
  let best = null;
  for (const entry of known.sources) {
    for (const alias of [entry.canonical, ...(entry.aliases ?? [])]) {
      let score = 0;
      if (THAI_RE.test(alias)) {
        const a = normalize(alias);
        if (a && nameNorm.includes(a)) score = a.replace(/\s/g, '').length / 3;
      } else {
        score = latinAliasMatches(alias, entry, name);
      }
      if (!score) continue;
      const better = !best || score > best.score ||
        (score === best.score && entry.specificity === 'document' && best.entry.specificity !== 'document');
      if (better) best = { entry, alias, score };
    }
  }
  return best;
}

/* ------------------------------------------------- leftover words (documents) */

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
/** Lower-cased word segments, Thai and Latin alike (ICU dictionary segmentation for Thai). */
const words = (s) => [...segmenter.segment(String(s ?? '').normalize('NFKC').toLowerCase())]
  .filter((x) => x.isWordLike).map((x) => x.segment);

// Words a genuine citation may add to ANY document's name without changing which document it is.
// Kept tight on purpose — every entry widens what a fabricated title can hide behind:
//   guideline(s)              the document noun every official title and paraphrase uses
//   diagnosis, treatment,     scope words of official titles ("… for the Diagnosis and Treatment
//   management                of …"); they name what a guideline covers, not a topic
//   update(d), focused        edition qualifiers ("2023 Focused Update")
//   report                    GINA / GOLD publish "reports"
//   thai                      the country qualifier on Thai national guidelines
//   clinical, practice        "Clinical Practice Guideline"
//   edition                   "2nd edition"
//   แนวทาง เวชปฏิบัติ การรักษา    guideline / practice / treatment — the Thai title nouns
//   ฉบับ ปรับปรุง                 edition / revised
//   สำหรับ                      "for" (the Thai titles' own preposition)
//   ประเทศไทย                  "Thailand"
//   พ.ศ / ค.ศ                   era markers before a year
// Stopwords (STOP), numbers (years) and single characters are ignored too. A word that a real
// document's full title needs belongs in THAT entry's aliases, not here.
const GENERIC = new Set([
  'guideline', 'guidelines', 'diagnosis', 'treatment', 'management', 'update', 'updated', 'focused',
  'report', 'thai', 'clinical', 'practice', 'edition',
  ...['แนวทาง', 'เวชปฏิบัติ', 'การรักษา', 'ฉบับ', 'ปรับปรุง', 'สำหรับ', 'ประเทศไทย'].flatMap(words),
  'พ.ศ', 'ค.ศ',
]);

const vocabCache = new WeakMap();
function entryVocab(entry) {
  let v = vocabCache.get(entry);
  if (!v) {
    v = new Set([entry.canonical, ...(entry.aliases ?? [])].flatMap(words));
    vocabCache.set(entry, v);
  }
  return v;
}

/** Words of a cited name that are neither the matched document's own words nor generic. Non-empty
 *  means "a real document plus something else" — the shape of a grafted, invented topic. */
export function leftoverWords(name, entry) {
  const vocab = entryVocab(entry);
  return [...new Set(words(name).filter((w) =>
    w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w) && !GENERIC.has(w) && !vocab.has(w)))];
}

export function yearValid(entry, yearCE) {
  if (yearCE == null) return false;
  if (Array.isArray(entry.years) && entry.years.includes(yearCE)) return true;
  if (Array.isArray(entry.year_range)) {
    const [from, to] = entry.year_range;
    return yearCE >= from && yearCE <= (to ?? CURRENT_YEAR);
  }
  return false;
}

/* ----------------------------------------------------------------- pubmed */

/** ≤ maxPerSecond requests, serialised. `now`/`sleep` injectable for tests. */
export function makeRateLimiter({ maxPerSecond = 3, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(1000 / maxPerSecond) + 10;
  let last = -Infinity;
  let chain = Promise.resolve();
  return function schedule() {
    chain = chain.then(async () => {
      const wait = last + gap - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    return chain;
  };
}

/** One esearch. Returns {count, ids, phraseMissing}. Throws on transport failure (caller decides).
 *  When PubMed cannot find a quoted phrase it DROPS it and searches the rest — "phrase AND 2023[dp]"
 *  then returns every paper from 2023. That is reported as count 0, never as a hit. */
export async function esearch(term, { fetchImpl = fetch, limiter, timeoutMs = 20000 } = {}) {
  if (limiter) await limiter();
  const url = `${ESEARCH}?db=pubmed&retmode=json&retmax=5&tool=clics-tutor-audit&term=${encodeURIComponent(term)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`esearch HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.esearchresult;
  if (!r) throw new Error('esearch: no esearchresult in response');
  if (r.ERROR) throw new Error(`esearch: ${r.ERROR}`);
  const phraseMissing = [
    ...(r.errorlist?.phrasesnotfound ?? []),
    ...(r.warninglist?.quotedphrasesnotfound ?? []),
  ].length > 0;
  return { count: phraseMissing ? 0 : Number(r.count || 0), ids: phraseMissing ? [] : (r.idlist ?? []), phraseMissing };
}

const AUTHOR_YEAR_RE = /^\p{Lu}[\p{L}'’-]+(?:\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+|\s+et\.?\s+al\.?)?$/u;

/* ---------------------------------------------------------------- verify */

/**
 * Classify one parsed citation.
 * @param {{name:string, yearCE:number|null}} cit
 * @param {{known:object, cache?:Map, fetchImpl?:Function, limiter?:Function, offline?:boolean}} ctx
 */
export async function verifyCitation(cit, ctx) {
  const base = { raw: cit.raw, name: cit.name, year: cit.year, year_ce: cit.yearCE, era: cit.era };
  if (cit.yearCE == null) return { ...base, status: 'unverified', basis: null, reason: 'no year could be parsed' };

  const hit = matchKnown(cit.name, ctx.known);
  if (hit) {
    const ok = yearValid(hit.entry, cit.yearCE);
    const family = hit.entry.specificity === 'family';
    const leftover = ok && !family ? leftoverWords(cit.name, hit.entry) : [];
    if (leftover.length) {
      return {
        ...base,
        status: 'document-unconfirmed',
        basis: 'curated',
        specificity: hit.entry.specificity,
        matched: hit.entry.canonical,
        matched_id: hit.entry.id,
        leftover,
        reason: `names a real document but adds words that are not part of it (${leftover.join(', ')}) — a human must check this document exists`,
      };
    }
    return {
      ...base,
      status: !ok ? 'year-mismatch' : (family ? 'publisher-only' : 'verified'),
      basis: 'curated',
      specificity: hit.entry.specificity,
      matched: hit.entry.canonical,
      matched_id: hit.entry.id,
      reason: ok
        ? (family ? 'publisher/series is real and publishes this year; the specific document is NOT identified — a human must check it exists' : undefined)
        : `curated source, but ${cit.yearCE} is not an edition year we hold (our lists are deliberately incomplete)`,
    };
  }
  if (THAI_RE.test(cit.name)) {
    return { ...base, status: 'unverified', basis: null, reason: 'Thai-language source not in the curated list; PubMed does not index it — needs a human' };
  }
  if (AUTHOR_YEAR_RE.test(cit.name.trim())) {
    return { ...base, status: 'unverified', basis: null, reason: 'author-year citation names no title, so it cannot be resolved to one paper' };
  }
  const org = organisationOnly(cit.name);
  if (org === 'organisation') {
    return { ...base, status: 'publisher-only', basis: 'organisation-name', specificity: 'family',
      reason: 'names only an organisation (optionally with a document-type word) — the document is NOT identified; not looked up in PubMed' };
  }
  if (org === 'bare-acronym') {
    return { ...base, status: 'unverified', basis: null,
      reason: 'a bare acronym that is not in the curated list — an organisation and a trial look the same; not looked up in PubMed' };
  }
  if (ctx.offline) return { ...base, status: 'unverified', basis: null, reason: 'offline — PubMed lookup skipped' };

  const phrase = cit.name.replace(/"/g, '').trim();
  const key = `${normalize(phrase)}|${cit.yearCE}`;
  let looked = ctx.cache?.get(key);
  if (!looked) {
    try {
      looked = await pubmedLookup(phrase, cit.yearCE, ctx);
      ctx.cache?.set(key, looked);
    } catch (e) {
      // Not cached: a failed lookup must be retried next run, not remembered as "not found".
      return { ...base, status: 'unverified', basis: null, reason: `PubMed lookup failed: ${e.message}` };
    }
  }
  const evidence = looked;
  // The caps are applied HERE, at classification time, so a cache written before they existed is
  // re-judged under them rather than trusted.
  const narrow = (n) => n != null && n >= 1 && n <= MAX_HITS;
  if (narrow(looked.phrase_year)) return { ...base, status: 'verified', basis: 'pubmed-phrase', specificity: 'pubmed', evidence };
  if (narrow(looked.words_year)) {
    return { ...base, status: 'verified', basis: 'pubmed-title-words', specificity: 'pubmed', evidence,
      reason: 'every title word matches a paper from this year (looser than an exact phrase)' };
  }
  if (narrow(looked.phrase_any) || narrow(looked.words_any)) {
    return { ...base, status: 'year-mismatch', basis: 'pubmed', specificity: 'pubmed', evidence, reason: 'a PubMed title matches, but not in this year' };
  }
  const hits = [looked.phrase_year, looked.words_year, looked.phrase_any, looked.words_any].filter((n) => n > MAX_HITS);
  return { ...base, status: 'unverified', basis: null, evidence,
    reason: hits.length ? `name too generic to resolve (${Math.max(...hits)} PubMed title hits)` : 'no curated match and no PubMed title match' };
}

// A title search that returns more than this many papers matched a topic or an organisation, not
// one citation. The SAME cap applies to the exact-phrase path and the title-words fallback: the
// phrase path used to accept any count, so "Endocrine Society, 2016" (37 papers) and "Centers for
// Disease Control and Prevention, 2024" (44) read verified.
export const MAX_HITS = 20;
export const WORDS_MAX_HITS = MAX_HITS; // kept for callers and tests that name the old constant

/* ------------------------------------------------------ organisation-only */

// Document-type words that may follow an organisation's name without identifying a document.
const DOC_TYPE_SUFFIX = /\s+(?:clinical\s+practice\s+(?:guidelines?|update)|clinical\s+policy|boxed\s+warning|guidelines?|statement|report)\s*$/i;
// The nouns organisations are named with. The whole name must be an organisation name built on one.
const ORG_NOUN = '(?:Society|Association|Academy|College|Institute|Institutes|Organi[sz]ation|Council|Federation|Foundation|Centers?|Centres?|Agency|Administration|Board|Committee|Consortium|Network|Ministry|Department)';
const ORG_NAME = new RegExp(
  `^(?:the\\s+)?(?:[A-Z][\\w'’&.-]*\\s+){0,6}${ORG_NOUN}` +
  `(?:\\s+(?:of|for|on)\\s+(?:(?:[A-Z][\\w'’-]*|and|&|the|of)\\s*){1,8})?$`);
const ACRONYM_TOKEN = /^[A-Z][A-Z0-9&-]*[A-Z0-9]$/;

/**
 * Is a cited name nothing but an organisation?
 *   'organisation'  a body's name ("Endocrine Society"), or acronym(s) followed by a document-type
 *                   word ("ACR Guideline", "AGA Clinical Practice Update") — publisher-only
 *   'bare-acronym'  only acronym token(s) and no document-type word ("AAO") — unverifiable as named
 *   null            anything else, including a real paper title that merely contains a body's name
 */
export function organisationOnly(name) {
  const trimmed = String(name).replace(/[*_]/g, '').trim();
  const stripped = trimmed.replace(DOC_TYPE_SUFFIX, '').trim();
  const hadDocType = stripped !== trimmed;
  if (!stripped) return null;
  const parts = stripped.split(/[\s/]+/).filter(Boolean);
  if (parts.length <= 3 && parts.every((t) => ACRONYM_TOKEN.test(t))) return hadDocType ? 'organisation' : 'bare-acronym';
  if (ORG_NAME.test(stripped)) return 'organisation';
  return null;
}

/**
 * The PubMed queries for one (name, year), in the order they stop being needed.
 * PubMed's phrase index does not hold every phrase — a real NEJM title with "in"/"with" in it can
 * come back phraseMissing — so an exact-phrase miss falls back to every significant title word
 * as [ti] AND the year, accepted only when it narrows to a handful of papers.
 */
export async function pubmedLookup(phrase, yearCE, ctx) {
  const words = tokens(phrase).filter((t) => t.length > 1);
  const wordsQ = words.length >= 3 ? words.map((w) => `${w}[ti]`).join(' AND ') : null;
  const out = { phrase_year: 0, words_year: null, phrase_any: null, words_any: null, pmids: [], queries: [], at: new Date().toISOString() };
  const run = async (term) => { out.queries.push(term); return esearch(term, ctx); };
  const py = await run(`"${phrase}"[Title] AND ${yearCE}[dp]`);
  out.phrase_year = py.count;
  out.pmids = py.ids;
  if (py.count > 0 && py.count <= MAX_HITS) return out;
  if (py.count > MAX_HITS) { out.pmids = []; return out; }   // a topic or a body, not a document
  if (wordsQ) {
    const wy = await run(`${wordsQ} AND ${yearCE}[dp]`);
    out.words_year = wy.count;
    if (wy.count >= 1 && wy.count <= MAX_HITS) { out.pmids = wy.ids; return out; }
  }
  out.phrase_any = (await run(`"${phrase}"[Title]`)).count;
  if (out.phrase_any > 0) return out;
  if (wordsQ) out.words_any = (await run(wordsQ)).count;
  return out;
}

/** Verify every citation in every final reply of a tutor-audit report. */
export async function verifyReport(report, ctx) {
  const items = [];
  for (const e of report.items) {
    const text = e.final?.ok ? e.final.text : '';
    const cits = extractReferences(text || '').flatMap((r) => parseCitations(r.source));
    const results = [];
    for (const c of cits) results.push(await verifyCitation(c, ctx));
    items.push({ id: e.id, n: results.length, citations: results });
  }
  const all = items.flatMap((i) => i.citations);
  const count = (s) => all.filter((c) => c.status === s).length;
  return {
    schema: 'clics-tutor-audit-cites/v1',
    report_label: report.label,
    checked_at: new Date().toISOString(),
    known_sources_version: ctx.known.version,
    offline: !!ctx.offline,
    summary: {
      citations: all.length,
      by_status: Object.fromEntries(STATUSES.map((s) => [s, count(s)])),
      verified_rate: wilson(count('verified'), all.length),
      items_with_unverified: items.filter((i) => i.citations.some((c) => c.status !== 'verified')).map((i) => i.id),
      note: '"unverified" means we could not confirm the source — NOT that it is fabricated. "publisher-only" (real publisher, document not identified) and "document-unconfirmed" (real document plus words that are not part of it) are NOT counted as verified. Verified means the source exists, not that it says what the reply claims.',
    },
    items,
  };
}

export async function loadKnownSources(file = KNOWN_SOURCES_FILE) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/* --------------------------------------------------------------------- CLI */

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/quality/cite-verify.mjs <report.json> [--offline] [--cache <file>]'); process.exit(2); }
  const ci = args.indexOf('--cache');
  const cacheFile = ci > -1 ? args[ci + 1] : DEFAULT_CACHE;
  const offline = args.includes('--offline');
  const report = JSON.parse(await readFile(file, 'utf8'));
  const known = await loadKnownSources();
  const cache = new Map(Object.entries(JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'))));
  const out = await verifyReport(report, { known, cache, offline, limiter: makeRateLimiter() });
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 2) + '\n', 'utf8');
  const outFile = file.replace(/\.json$/, '.cites.json');
  await writeFile(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const s = out.summary;
  console.log(`\n  citations checked: ${s.citations} (curated list ${known.version}, ${known.sources.length} sources${offline ? ', OFFLINE' : ''})`);
  for (const st of STATUSES) console.log(`    ${st.padEnd(14)} ${s.by_status[st]}`);
  console.log(`    verified rate  ${fmtRate(s.verified_rate)}`);
  console.log(`\n  ${s.note}`);
  console.log(`  written: ${outFile}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) await main();
