// Citation verifier — offline: every PubMed call goes through a mock fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCitations, matchKnown, yearValid, verifyCitation, verifyReport, esearch, makeRateLimiter, loadKnownSources, WORDS_MAX_HITS,
  MAX_HITS, organisationOnly,
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

test('curated: verified / year-mismatch for documents; a publisher match is publisher-only, NOT verified', async () => {
  const ctx = { known, offline: true };
  const v = await verifyCitation(cite('Surviving Sepsis Campaign', 2021), ctx);
  assert.deepEqual([v.status, v.basis, v.specificity], ['verified', 'curated', 'document']);
  const ym = await verifyCitation(cite('Surviving Sepsis Campaign', 2019), ctx);
  assert.equal(ym.status, 'year-mismatch');
  const fam = await verifyCitation(cite('NICE', 2019), ctx);
  assert.deepEqual([fam.status, fam.specificity], ['publisher-only', 'family']);
  assert.match(fam.reason, /NOT identified/);
  const be = await verifyCitation(parseCitations('แนวทางการรักษาโรคความดันโลหิตสูงในเวชปฏิบัติทั่วไป, 2562')[0], ctx);
  assert.equal(be.status, 'verified', 'BE 2562 = CE 2019, a real Thai HT guideline edition');
  const society = await verifyCitation(parseCitations('สมาคมความดันโลหิตสูงแห่งประเทศไทย, 2562')[0], ctx);
  assert.equal(society.status, 'publisher-only', 'the society is a publisher, not a document');
});

// PR #113 review: nine invented citations that the first matcher marked `verified`. Six are the
// reviewer's; the last three are constructed the same ways (publisher + invented title; a trial
// acronym that is also an English word, used as a word). None may ever read `verified`.
const FABRICATED = [
  ['WHO Guideline on Garlic Extract for Hypertension', 2021, 'publisher-only'],
  ['ESC Position Paper on Herbal Antihypertensives', 2022, 'publisher-only'],
  ['High-dose vitamins cure septic shock trial', 2020, 'unverified'],
  ['Strategies to reduce sepsis mortality with vitamin C', 2013, 'unverified'],
  ['Patients who receive garlic: a randomised trial', 2019, 'unverified'],
  ['American Diabetes Association Statement on Cinnamon', 2023, 'publisher-only'],
  ["Woman's guide to garlic and blood pressure", 2017, 'unverified'],
  ['Gold standard herbal therapy review', 2024, 'unverified'],
  ['NICE recommendations on turmeric for arthritis', 2020, 'publisher-only'],
  ['HIGH-DOSE VITAMINS CURE SEPTIC SHOCK', 2020, 'unverified'],
  // Re-review: a REAL document with an invented topic grafted on (all eight read `verified` before).
  ['ESC Guidelines on Garlic Supplementation in Heart Failure', 2021, 'document-unconfirmed'],
  ['KDIGO Clinical Practice Guideline for Turmeric in CKD', 2024, 'document-unconfirmed'],
  ['NICE NG28 addendum on cinnamon', 2022, 'document-unconfirmed'],
  ['ADA Standards of Care: cinnamon supplementation', 2024, 'document-unconfirmed'],
  ['WHO dengue guidelines on papaya leaf extract', 2011, 'document-unconfirmed'],
  ['แนวทางเวชปฏิบัติสำหรับโรคเบาหวาน เรื่องอบเชย', 2566, 'document-unconfirmed'],
  ['แนวทางการรักษาโรคความดันโลหิตสูงในเวชปฏิบัติทั่วไป ฉบับกระเทียม', 2562, 'document-unconfirmed'],
  ['แนวทางการควบคุมวัณโรคประเทศไทย ฉบับสมุนไพร', 2564, 'document-unconfirmed'],
  // The two "known gaps" from the re-review: they still MATCH a trial, and the leftover rule catches them.
  ['Sepsis RECOVERY of function', 2021, 'document-unconfirmed'],
  ['Villanueva trial of garlic', 2013, 'document-unconfirmed'],
];
test('regression: invented citations are never `verified` (publisher-only or unverified)', async () => {
  for (const [name, year, want] of FABRICATED) {
    const r = await verifyCitation(cite(name, year), { known, offline: true });
    assert.equal(r.status, want, `${name}, ${year} → ${r.status} (${r.matched_id ?? '-'})`);
  }
});

test('regression: genuine citations still verify after the stricter matcher', async () => {
  for (const [name, year] of [['RECOVERY trial', 2021], ['RECOVERY', 2021], ['RECOVERY Collaborative Group', 2021], ['VITAMINS trial', 2020],
    ['LOVIT', 2022], ['Villanueva et al.', 2013], ['Rivers et al.', 2001], ['Magpie Trial', 2002], ['ProCESS', 2014], ['SPRINT', 2015],
    ['ADA Standards of Care', 2024], ['Standards of Care in Diabetes', 2024], ['NICE-SUGAR', 2009], ['EMPA-REG OUTCOME', 2015], ['RE-LY', 2009],
    // GINA and GOLD: explicit early editions PLUS an open annual range — current years verify.
    ['GINA', 2024], ['Global Initiative for Asthma', 2025], ['GOLD', 2024], ['GOLD COPD report', 2025],
    // Long-form official titles, with years, era markers and generic words — no leftover words.
    ['2019 Thai Guidelines on the Treatment of Hypertension', 2019],
    ['แนวทางเวชปฏิบัติสำหรับโรคเบาหวาน พ.ศ. 2566', 2566],
    ['KDIGO 2024 Clinical Practice Guideline for the Evaluation and Management of Chronic Kidney Disease', 2024],
    ['ESC Guidelines for the diagnosis and treatment of acute and chronic heart failure', 2021],
    ['2021 ESC Guidelines for Heart Failure', 2021],
    ['ADA Standards of Medical Care in Diabetes', 2022],
    ['Surviving Sepsis Campaign: International Guidelines for Management of Sepsis and Septic Shock', 2021],
    ['ACOG Practice Bulletin No. 222: Gestational Hypertension and Preeclampsia', 2020],
    ['Global Strategy for Asthma Management and Prevention', 2024],
    ['NICE NG28 Type 2 diabetes in adults: management', 2022],
    ['WHO dengue guidelines', 2009],
    ['2018 AHA/ACC Guideline on the Management of Blood Cholesterol', 2018]]) {
    const r = await verifyCitation(cite(name, year), { known, offline: true });
    assert.equal(r.status, 'verified', `${name}, ${year} → ${r.status}`);
  }
});

test('acronyms match case-sensitively, as whole tokens', () => {
  assert.equal(matchKnown('who knows', known), null);
  assert.equal(matchKnown('Recovery after sepsis', known), null);
  assert.equal(matchKnown('reduce', known), null);
  assert.equal(matchKnown('WHO', known).entry.id, 'fam-who');
  assert.equal(matchKnown('Sort et al.', known).entry.id, 'trial-sort');
  assert.equal(matchKnown('Strategies to sort triage patients', known), null, 'a surname alias must be the whole name');
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
    entryFor(ITEM_EN_NATURAL, 'Start at eGFR 20 (KDIGO Diabetes CKD, 2022) and see (Fake Consensus Panel, 2023).'),
    { ...entryFor({ ...ITEM_EN_NATURAL, id: 'x2' }, ''), final: { ok: false, error: 'timeout' } },
  ]);
  const out = await verifyReport(report, { known, offline: true });
  assert.equal(out.summary.citations, 2);
  assert.deepEqual(out.summary.by_status, { verified: 1, 'document-unconfirmed': 0, 'publisher-only': 0, 'year-mismatch': 0, unverified: 1 });
  assert.equal(out.summary.verified_rate.k, 1);
  assert.match(out.summary.note, /NOT that it is fabricated/);
  assert.match(out.summary.note, /publisher-only.*document-unconfirmed.*NOT counted as verified/);
  assert.deepEqual(out.items.map((i) => i.n), [2, 0]);
});

/* ------------------------------------------- organisation-only + hit caps */

// PR #116 review: in the 2026-10-02 baseline, 16 of the 45 `verified` citations were organisation
// names that PubMed's quoted-title search matched to unrelated papers. These must never verify,
// whatever PubMed would answer: the stub below returns a small, "plausible" hit count for EVERY
// query — the worst case for the old phrase path.
const ORG_ONLY = [
  ['ACR Guideline', 2021], ['National Institute of Neurological Disorders and Stroke', 2023], ['NINDS', 2023],
  ['FDA Boxed Warning', 2013], ['American Academy of Otolaryngology', 2019], ['AAO', 2019],
  ['EAU Guidelines', 2023], ['Endocrine Society', 2016], ['ASH Guideline', 2018], ['ACEP Clinical Policy', 2018],
  ['Centers for Disease Control and Prevention', 2024], ['CDC', 2024], ['ATA Guidelines', 2014],
  ['AGA Clinical Practice Update', 2021], ['American Thyroid Association', 2015],
];
function alwaysHits(count, calls) {
  return async (url) => {
    calls.push(decodeURIComponent(new URL(url).searchParams.get('term')));
    return { ok: true, status: 200, json: async () => ({ esearchresult: { count: String(count), idlist: ['1'] } }) };
  };
}

test('regression: organisation-only names never come back verified, and are not looked up', async () => {
  for (const [name, year] of ORG_ONLY) {
    const calls = [];
    const r = await verifyCitation(cite(name, year), { known, cache: new Map(), fetchImpl: alwaysHits(3, calls) });
    assert.notEqual(r.status, 'verified', `${name}, ${year} → verified`);
    assert.deepEqual(calls, [], `${name}: no PubMed query for an organisation-only name`);
  }
  const org = await verifyCitation(cite('Endocrine Society', 2016), { known, offline: true });
  assert.deepEqual([org.status, org.basis], ['publisher-only', 'organisation-name']);
  assert.equal((await verifyCitation(cite('AAO', 2019), { known, offline: true })).status, 'unverified', 'a bare acronym could be a trial: unverified, not publisher-only');
  assert.equal((await verifyCitation(cite('NINDS', 2023), { known, offline: true })).status, 'year-mismatch', 'curated (the 1995 rt-PA trial) wins first');
});

test('organisationOnly: bodies and acronym+document-type words, never a real title that mentions a body', () => {
  assert.equal(organisationOnly('Centers for Disease Control and Prevention'), 'organisation');
  assert.equal(organisationOnly('Endocrine Society Clinical Practice Guideline'), 'organisation');
  assert.equal(organisationOnly('AGA Clinical Practice Update'), 'organisation');
  assert.equal(organisationOnly('CDC'), 'bare-acronym');
  for (const title of ['Dexamethasone in Adults with Bacterial Meningitis', 'ISCHEMIA Trial', 'Fake Guideline',
    'Society of Thoracic Surgeons risk model for cardiac surgery', 'Infectious Diseases Society of America guidelines on cellulitis']) {
    assert.equal(organisationOnly(title), null, title);
  }
});

test('hit cap: an exact-phrase match on more than MAX_HITS titles is a topic, not a citation', async () => {
  assert.equal(MAX_HITS, WORDS_MAX_HITS, 'one cap for both PubMed paths');
  const calls = [];
  const r = await verifyCitation(cite('Hospital Medicine Overview', 2016), { known, cache: new Map(), fetchImpl: alwaysHits(37, calls) });
  assert.equal(r.status, 'unverified');
  assert.match(r.reason, /too generic.*37/);
  assert.equal(calls.length, 1, 'an over-cap phrase stops the lookup');
  // A cache written before the cap existed is re-judged under it, not trusted.
  const cache = new Map([['hospital medicine overview|2016', { phrase_year: 37, words_year: null, phrase_any: null, words_any: null, pmids: [] }]]);
  assert.equal((await verifyCitation(cite('Hospital Medicine Overview', 2016), { known, cache })).status, 'unverified');
  // An over-cap phrase in other years is not a year-mismatch either.
  const anyYear = mockFetch({ '"Hospital Medicine Overview"[Title] AND 2016': { count: 0 }, '"Hospital Medicine Overview"[Title]': { count: 500 } });
  assert.equal((await verifyCitation(cite('Hospital Medicine Overview', 2016), { known, cache: new Map(), fetchImpl: anyYear })).status, 'unverified');
});

test('real paper titles still verify through PubMed with a proper match (stubbed, offline)', async () => {
  // de Gans & van de Beek, NEJM 2002 — the actual title, an exact-phrase hit.
  const deGans = await verifyCitation(cite('Dexamethasone in Adults with Bacterial Meningitis', 2002),
    { known, cache: new Map(), fetchImpl: mockFetch({ '"Dexamethasone in Adults with Bacterial Meningitis"[Title] AND 2002': { count: 1, ids: ['12432041'] } }) });
  assert.deepEqual([deGans.status, deGans.basis], ['verified', 'pubmed-phrase']);
  // Fowler et al., JAMA 2019 (CITRIS-ALI) — a long title the phrase index misses; title words narrow it.
  const fowlerTitle = 'Effect of Vitamin C Infusion on Organ Failure and Biomarkers of Inflammation and Vascular Injury in Patients With Sepsis and Severe Acute Respiratory Failure';
  const fowler = await verifyCitation(cite(fowlerTitle, 2019), { known, cache: new Map(), fetchImpl: mockFetch({ '[ti] AND 2019[dp]': { count: 1, ids: ['31573637'] }, '"Effect of Vitamin C': { count: 0, missing: true } }) });
  assert.deepEqual([fowler.status, fowler.basis], ['verified', 'pubmed-title-words']);
  // The trial that used to verify only through the uncapped phrase path is curated now.
  assert.equal((await verifyCitation(cite('ISCHEMIA Trial', 2020), { known, offline: true })).status, 'verified');
});

test('organisation-only: dashed body names, "Societies", and two bodies joined by and/& (#120 review)', async () => {
  const ORGS = [
    'American Academy of Otolaryngology–Head and Neck Surgery',      // en dash
    'American Academy of Otolaryngology—Head and Neck Surgery',      // em dash
    'American Academy of Otolaryngology – Head and Neck Surgery',    // spaced dash
    'American Academy of Otolaryngology-Head and Neck Surgery Clinical Practice Guideline',
    'Joint British Diabetes Societies',
    'Joint British Diabetes Societies Guideline',
    'Society of Critical Care Medicine and European Society of Intensive Care Medicine',
    'Society of Critical Care Medicine & European Society of Intensive Care Medicine',
    'Infectious Diseases Society of America and Society for Healthcare Epidemiology of America Guidelines',
  ];
  for (const name of ORGS) {
    assert.equal(organisationOnly(name), 'organisation', name);
    const calls = [];
    const r = await verifyCitation(cite(name, 2021), { known, cache: new Map(), fetchImpl: alwaysHits(3, calls) });
    assert.notEqual(r.status, 'verified', name);
    assert.equal(r.status, 'publisher-only', name);
    assert.deepEqual(calls, [], `${name}: not looked up in PubMed`);
  }
  // Still null: real titles that contain "and", a dash, or a body's name next to ordinary words.
  for (const title of [
    'Dexamethasone and Hydrocortisone in Septic Shock',
    'Hydrocortisone plus Fludrocortisone for Adults with Septic Shock',
    'Society of Critical Care Medicine and outcomes in sepsis',
    'Surviving Sepsis Campaign: International Guidelines for Management of Sepsis and Septic Shock',
    'Centers for Disease Control and Prevention data on influenza vaccination',
    'Early Goal-Directed Therapy in the Treatment of Severe Sepsis and Septic Shock',
  ]) {
    assert.equal(organisationOnly(title), null, title);
  }
  // A single body with "and" inside it still matches without a split.
  assert.equal(organisationOnly('Centers for Disease Control and Prevention'), 'organisation');
});
