// Citation verifier — offline: every PubMed call goes through a mock fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCitations, matchKnown, yearValid, verifyCitation, verifyReport, esearch, makeRateLimiter, loadKnownSources, WORDS_MAX_HITS,
} from './cite-verify.mjs';
import { reportFor, entryFor, ITEM_EN_NATURAL } from './test-fixtures.mjs';

const known = await loadKnownSources();

/** Mock E-utilities: `table` maps a substring of the decoded term → {count, ids, missing}. */
function mockFetch(table, log = []) {
  return async (url) => {
    const term = decodeURIComponent(new URL(url).searchParams.get('term'));
    log.push(term);
    const hit = Object.entries(table).find(([k]) => term.includes(k))?.[1] ?? { count: 0 };
    const esearchresult = { count: String(hit.count), idlist: hit.ids ?? [] };
    if (hit.missing) esearchresult.warninglist = { quotedphrasesnotfound: ['x'] };
    return { ok: true, status: 200, json: async () => ({ esearchresult }) };
  };
}
const cite = (name, year) => parseCitations(`${name}, ${year}`)[0];

test('known-sources.json: >= 60 entries, unique ids, sane years, aliases present', () => {
  assert.ok(known.sources.length >= 60, `${known.sources.length}`);
  assert.equal(new Set(known.sources.map((s) => s.id)).size, known.sources.length);
  const now = new Date().getUTCFullYear();
  for (const s of known.sources) {
    assert.ok(s.canonical && Array.isArray(s.aliases) && s.aliases.length, s.id);
    assert.ok(['document', 'family'].includes(s.specificity), s.id);
    assert.ok(s.years || s.year_range, `${s.id} has no years`);
    for (const y of s.years ?? []) assert.ok(Number.isInteger(y) && y >= 1940 && y <= now, `${s.id} ${y}`);
    if (s.year_range) assert.ok(s.year_range[0] <= (s.year_range[1] ?? now), s.id);
  }
});

test('parseCitations: Buddhist-Era years convert, ";" splits, no year → null', () => {
  assert.deepEqual(parseCitations('แนวทางเวชปฏิบัติสำหรับโรคเบาหวาน, 2566').map((c) => [c.yearCE, c.era]), [[2023, 'BE']]);
  assert.deepEqual(parseCitations('KDIGO, 2012; NICE NG203, 2021').map((c) => [c.name, c.yearCE]), [['KDIGO', 2012], ['NICE NG203', 2021]]);
  assert.equal(parseCitations('ADA Standards of Care, 2024 update')[0].yearCE, 2024);
  assert.equal(parseCitations('no year here')[0].yearCE, null);
});

test('matchKnown: most specific alias wins; Thai aliases match as substrings', () => {
  assert.equal(matchKnown('KDIGO AKI Guideline', known).entry.id, 'kdigo-aki');
  assert.equal(matchKnown('KDIGO', known).entry.id, 'fam-kdigo');
  assert.equal(matchKnown('NICE-SUGAR', known).entry.id, 'trial-nicesugar', 'not the NICE publisher family');
  assert.equal(matchKnown('ESC Guidelines for Heart Failure', known).entry.id, 'esc-hf');
  assert.equal(matchKnown('Surviving Sepsis Campaign Pediatric Guidelines', known).entry.id, 'ssc-paeds');
  assert.equal(matchKnown('แนวทางเวชปฏิบัติสำหรับโรคเบาหวาน สมาคมโรคเบาหวานแห่งประเทศไทย', known).entry.id, 'thai-dm-cpg');
  assert.equal(matchKnown('Thai Journal of Imaginary Cardiology', known), null);
});

test('yearValid: explicit years and open ranges', () => {
  assert.equal(yearValid({ years: [2012, 2024] }, 2024), true);
  assert.equal(yearValid({ years: [2012, 2024] }, 2019), false);
  assert.equal(yearValid({ year_range: [1989, null] }, new Date().getUTCFullYear()), true);
  assert.equal(yearValid({ year_range: [1989, null] }, 1980), false);
});

test('curated: verified / year-mismatch, with publisher-only specificity said out loud', async () => {
  const ctx = { known, offline: true };
  const v = await verifyCitation(cite('Surviving Sepsis Campaign', 2021), ctx);
  assert.deepEqual([v.status, v.basis, v.specificity], ['verified', 'curated', 'document']);
  const ym = await verifyCitation(cite('Surviving Sepsis Campaign', 2019), ctx);
  assert.equal(ym.status, 'year-mismatch');
  const fam = await verifyCitation(cite('NICE', 2019), ctx);
  assert.equal(fam.specificity, 'family');
  assert.match(fam.reason, /not identified/);
  const be = await verifyCitation(parseCitations('สมาคมความดันโลหิตสูงแห่งประเทศไทย, 2562')[0], ctx);
  assert.equal(be.status, 'verified', 'BE 2562 = CE 2019, a real Thai HT guideline edition');
});

test('never says "fabricated": Thai unknowns and author-year cites are unverified, with the reason', async () => {
  const ctx = { known, fetchImpl: () => { throw new Error('must not be called'); } };
  const th = await verifyCitation(cite('วารสารหทัยวิทยาจินตนาการ', 2021), ctx);
  assert.equal(th.status, 'unverified');
  assert.match(th.reason, /PubMed does not index/);
  const ay = await verifyCitation(cite('Smith et al.', 2019), ctx);
  assert.equal(ay.status, 'unverified');
  assert.match(ay.reason, /author-year/);
  for (const r of [th, ay]) assert.doesNotMatch(JSON.stringify(r), /fabricat/i);
});

test('PubMed: exact-phrase hit verifies; the query is phrase[Title] AND year[dp]', async () => {
  const log = [];
  const ctx = { known, cache: new Map(), fetchImpl: mockFetch({ '"Semaglutide Outcomes Report"[Title] AND 2023[dp]': { count: 2, ids: ['1', '2'] } }, log) };
  const r = await verifyCitation(cite('Semaglutide Outcomes Report', 2023), ctx);
  assert.deepEqual([r.status, r.basis], ['verified', 'pubmed-phrase']);
  assert.deepEqual(log, ['"Semaglutide Outcomes Report"[Title] AND 2023[dp]']);
});

test('PubMed: phrase index miss falls back to title words, accepted only when narrow', async () => {
  const narrow = { known, cache: new Map(), fetchImpl: mockFetch({ 'dapagliflozin[ti] AND patients[ti]': { count: 5, ids: ['9'] }, '"Dapagliflozin': { count: 0, missing: true } }) };
  const r = await verifyCitation(cite('Dapagliflozin in Patients with Chronic Kidney Disease', 2020), narrow);
  assert.deepEqual([r.status, r.basis], ['verified', 'pubmed-title-words']);
  const broad = { known, cache: new Map(), fetchImpl: mockFetch({ 'heart[ti] AND failure[ti] AND management[ti] AND 2020': { count: WORDS_MAX_HITS + 500 }, 'heart[ti] AND failure[ti] AND management[ti]': { count: 9000 } }) };
  const g = await verifyCitation(cite('Heart Failure Management Review', 2020), broad);
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /too generic/);
});

test('PubMed: a hit only without the year is year-mismatch; a dropped quoted phrase never counts as a hit', async () => {
  const ctx = { known, cache: new Map(), fetchImpl: mockFetch({ '"Ascorbate Septic Shock Report"[Title] AND 2019': { count: 0 }, '"Ascorbate Septic Shock Report"[Title]': { count: 1 } }) };
  const ym = await verifyCitation(cite('Ascorbate Septic Shock Report', 2019), ctx);
  assert.deepEqual([ym.status, ym.basis], ['year-mismatch', 'pubmed']);
  // PubMed drops an unfound quoted phrase and searches the rest: "Fake Guideline" AND 2023 → every 2023 paper.
  const dropped = mockFetch({ 'Fake': { count: 1500000, missing: true } });
  assert.deepEqual(await esearch('"Fake Guideline"[Title] AND 2023[dp]', { fetchImpl: dropped }), { count: 0, ids: [], phraseMissing: true });
  const v = await verifyCitation(cite('Fake Guideline', 2023), { known, cache: new Map(), fetchImpl: dropped });
  assert.equal(v.status, 'unverified');
});

test('cache: a hit is reused without a request; a FAILED lookup is not cached', async () => {
  const cache = new Map();
  let calls = 0;
  const fetchImpl = async (u) => { calls += 1; return mockFetch({ 'Some Real Title': { count: 1, ids: ['5'] } })(u); };
  await verifyCitation(cite('Some Real Title', 2018), { known, cache, fetchImpl });
  await verifyCitation(cite('Some Real Title', 2018), { known, cache, fetchImpl });
  assert.equal(calls, 1);
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await verifyCitation(cite('Another Title Words', 2018), { known, cache, fetchImpl: failing });
  assert.equal(r.status, 'unverified');
  assert.match(r.reason, /lookup failed/);
  assert.equal([...cache.keys()].some((k) => k.startsWith('another title words')), false);
});

test('rate limiter: never more than 3 requests per second (fake clock)', async () => {
  let t = 0;
  const stamps = [];
  const limiter = makeRateLimiter({ maxPerSecond: 3, now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 7; i++) { await limiter(); stamps.push(t); }
  for (let i = 3; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 3] >= 1000, `window ${i}: ${stamps[i] - stamps[i - 3]} ms`);
});

test('verifyReport: per-item citations and a summary that refuses to say "fabricated"', async () => {
  const report = reportFor('t', 'local', 'm', [
    entryFor(ITEM_EN_NATURAL, 'Start at eGFR 20 (KDIGO Diabetes CKD, 2022) and see (Fake Society, 2023).'),
    { ...entryFor({ ...ITEM_EN_NATURAL, id: 'x2' }, ''), final: { ok: false, error: 'timeout' } },
  ]);
  const out = await verifyReport(report, { known, offline: true });
  assert.equal(out.summary.citations, 2);
  assert.deepEqual(out.summary.by_status, { verified: 1, 'year-mismatch': 0, unverified: 1 });
  assert.equal(out.summary.verified_rate.k, 1);
  assert.match(out.summary.note, /NOT that it is fabricated/);
  assert.deepEqual(out.items.map((i) => i.n), [2, 0]);
});
