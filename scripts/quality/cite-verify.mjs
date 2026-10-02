#!/usr/bin/env node
// cite-verify.mjs — are the tutor's (Source, Year) citations REAL?
//
// rimpl's hasCitation() checks only the SHAPE "(something, 1234)". A confidently invented
// "(Fake Guideline, 2023)" passes it, and so did every Gate 0 reply. This script checks the source:
//
//   1. Curated match — scripts/quality/known-sources.json lists real guidelines, statements and
//      landmark trials with their aliases and the edition years we are sure of. A name match with a
//      listed year is `verified`; a name match with an unlisted year is `year-mismatch`.
//   2. PubMed — anything not curated is looked up with NCBI E-utilities esearch: the cited name as a
//      quoted [Title] phrase AND the year as [dp], falling back to every title word as [ti] (accepted
//      only when it narrows to <= WORDS_MAX_HITS papers). A hit is `verified`; a hit only without the
//      year is `year-mismatch`; nothing is `unverified`.
//
// THE THREE LABELS, AND WHAT THEY DO NOT MEAN
//   verified       a real document with this name exists for this year. It does NOT mean the
//                  document says what the reply claims it says — that is the judges' and the
//                  clinician's question (rubric dimension: citation honesty).
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
export const STATUSES = ['verified', 'year-mismatch', 'unverified'];
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

/* --------------------------------------------------------- curated match */

/** Best curated entry for a cited name, or null. Latin aliases match when every alias token appears
 *  in the name (so "ESC Guidelines for Heart Failure" matches the alias "ESC heart failure");
 *  Thai aliases (no word spaces) match as substrings. The most specific alias wins. */
export function matchKnown(name, known) {
  const nameNorm = normalize(name);
  const nameToks = new Set(tokens(name));
  let best = null;
  for (const entry of known.sources) {
    for (const alias of [entry.canonical, ...(entry.aliases ?? [])]) {
      let score = 0;
      if (THAI_RE.test(alias)) {
        const a = normalize(alias);
        if (a && nameNorm.includes(a)) score = a.replace(/\s/g, '').length / 3;
      } else {
        const at = tokens(alias);
        if (at.length && at.every((t) => nameToks.has(t))) score = at.length;
      }
      if (!score) continue;
      const better = !best || score > best.score ||
        (score === best.score && entry.specificity === 'document' && best.entry.specificity !== 'document');
      if (better) best = { entry, alias, score };
    }
  }
  return best;
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
    return {
      ...base,
      status: ok ? 'verified' : 'year-mismatch',
      basis: 'curated',
      specificity: hit.entry.specificity,
      matched: hit.entry.canonical,
      matched_id: hit.entry.id,
      reason: ok
        ? (hit.entry.specificity === 'family' ? 'publisher/series is real and publishes this year; the specific document is not identified' : undefined)
        : `curated source, but ${cit.yearCE} is not an edition year we hold (our lists are deliberately incomplete)`,
    };
  }
  if (THAI_RE.test(cit.name)) {
    return { ...base, status: 'unverified', basis: null, reason: 'Thai-language source not in the curated list; PubMed does not index it — needs a human' };
  }
  if (AUTHOR_YEAR_RE.test(cit.name.trim())) {
    return { ...base, status: 'unverified', basis: null, reason: 'author-year citation names no title, so it cannot be resolved to one paper' };
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
  if (looked.phrase_year > 0) return { ...base, status: 'verified', basis: 'pubmed-phrase', specificity: 'pubmed', evidence };
  if (looked.words_year != null && looked.words_year >= 1 && looked.words_year <= WORDS_MAX_HITS) {
    return { ...base, status: 'verified', basis: 'pubmed-title-words', specificity: 'pubmed', evidence,
      reason: 'every title word matches a paper from this year (looser than an exact phrase)' };
  }
  if (looked.phrase_any > 0 || (looked.words_any != null && looked.words_any >= 1 && looked.words_any <= WORDS_MAX_HITS)) {
    return { ...base, status: 'year-mismatch', basis: 'pubmed', specificity: 'pubmed', evidence, reason: 'a PubMed title matches, but not in this year' };
  }
  const generic = looked.words_year != null && looked.words_year > WORDS_MAX_HITS;
  return { ...base, status: 'unverified', basis: null, evidence,
    reason: generic ? `name too generic to resolve (${looked.words_year} title-word hits)` : 'no curated match and no PubMed title match' };
}

// A title-words AND query that returns more than this many papers is a topic, not a citation.
export const WORDS_MAX_HITS = 20;

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
  if (py.count > 0) return out;
  if (wordsQ) {
    const wy = await run(`${wordsQ} AND ${yearCE}[dp]`);
    out.words_year = wy.count;
    if (wy.count >= 1 && wy.count <= WORDS_MAX_HITS) { out.pmids = wy.ids; return out; }
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
      note: '"unverified" means we could not confirm the source — NOT that it is fabricated. Verified means the source exists, not that it says what the reply claims.',
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
