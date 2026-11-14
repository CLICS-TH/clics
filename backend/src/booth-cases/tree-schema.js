const { z } = require('zod');
const { WEIGHTS, compositeScore } = require('../services/ple-gate');
const { treeSha, reviewedSha } = require('./tree-sha');

const TIERS = Object.freeze([
  Object.freeze({ name: 'best', letter: 'B' }),
  Object.freeze({ name: 'reasonable', letter: 'R' }),
  Object.freeze({ name: 'weaker', letter: 'W' }),
]);
const LETTERS = TIERS.map((t) => t.letter);
/** Every tier path of `length` letters, B…B first and W…W last. */
const tierPaths = (length) => {
  if (length === 0) return [''];
  const rest = tierPaths(length - 1);
  return LETTERS.flatMap((a) => rest.map((r) => a + r));
};
const LANGS = ['th', 'en'];

// rimpl sends variant and option ids to the AI as written (rimpl/src/services/booth.js bankIn), so an id holds no room
// for an identifier: a variant is v1 to v3, and an option a short word of letters and underscores with at most one
// digit (abx5, o2_iv, opd_2wk), never a number such as an HN or a phone (gate #370 on PR #482).
const VariantId = z.string().regex(/^v[1-3]$/, 'must match /^v[1-3]$/');
const OptionId = z.string().regex(/^(?=.{1,16}$)[a-z][a-z_]*(?:[0-9][a-z_]*)?$/, 'must be 1-16 letters and underscores, with at most one digit');
const Text = z.string().trim().min(1);
const Bilingual = z.object({ th: Text, en: Text }).strict();
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'is not a calendar date');

const Bank = z.object({
  variants: z.array(z.object({ id: VariantId, question: Bilingual }).strict()).min(2).max(3),
  options: z.array(z.object({
    id: OptionId,
    tier: z.enum(TIERS.map((t) => t.name)),
    label: Bilingual,
    line: Bilingual,
  }).strict()).min(3).max(6),
  default_trio: z.array(OptionId).length(3),
}).strict().superRefine((bank, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  for (const list of ['variants', 'options']) {
    bank[list].forEach((x, i) => {
      if (bank[list].findIndex((y) => y.id === x.id) < i) issue([list, i, 'id'], `duplicate id "${x.id}"`);
    });
  }
  for (const { name } of TIERS) {
    const n = bank.options.filter((o) => o.tier === name).length;
    if (n < 1 || n > 2) issue(['options'], `needs 1 or 2 ${name} options, has ${n}`);
  }
  const trio = bank.default_trio.map((id) => bank.options.find((o) => o.id === id));
  trio.forEach((o, i) => { if (!o) issue(['default_trio', i], `"${bank.default_trio[i]}" is not an option of this bank`); });
  const tiers = trio.filter(Boolean).map((o) => o.tier);
  if (TIERS.some(({ name }) => !tiers.includes(name))) {
    issue(['default_trio'], `must name one option per tier, names ${tiers.join(', ') || 'none'}`);
  }
});
const keyedBanks = (keys) => z.object(Object.fromEntries(keys.map((k) => [k, Bank]))).strict();

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
// A three-step domain is the median of three whole evaluator samples, on the evaluator's own 0-5 scale. A five-step
// domain is a fitted value held to one decimal (scripts/booth/path-fit.mjs). booth_plays.d1..d7 are checked 0 to 5.
const WholeDomain = z.number().int().min(0).max(5);
const TenthDomain = z.number().min(0).max(5).refine((v) => Math.round(v * 10) / 10 === v, 'must have at most one decimal');
// Field names follow rimpl's model manifest.
const pathScoreTable = (steps, method, domain) => z.object({
  provenance: z.object({
    evaluator_model: Text,
    prompt_sha256: Sha256,
    decoding: z.object({ temperature: z.number().min(0), max_tokens: z.number().int().positive() }).strict(),
    samples_per_path: z.number().int().min(1),
    method: z.literal(method),
    run_id: Text,
    date: CalendarDate,
    tree_sha256: Sha256,
  }).strict(),
  paths: z.object(Object.fromEntries(tierPaths(steps).map((p) => [p,
    z.object(Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, domain]))).strict()]))).strict(),
}).strict();

/** A tree shape (spec #370, ADR 0011). Three-step banks are keyed by every tier chosen so far and scored by a median
 *  table; five-step banks by the previous tier alone (keying on the whole path would need 121 banks) and scored by a
 *  fitted table, one decimal per domain and a whole composite. */
const shape = (steps, { keyLength, method, domain, composite }) => Object.freeze({
  method,
  composite,
  banks: z.object({
    step1: Bank,
    ...Object.fromEntries(Array.from({ length: steps - 1 }, (_, i) => [`step${i + 2}`, keyedBanks(tierPaths(keyLength(i + 2)))])),
  }).strict(),
  table: pathScoreTable(steps, method, domain),
});
const SHAPES = Object.freeze({
  3: shape(3, { keyLength: (n) => n - 1, method: 'median', domain: WholeDomain, composite: compositeScore }),
  5: shape(5, { keyLength: () => 1, method: 'median-regression', domain: TenthDomain, composite: (d) => Math.round(compositeScore(d)) }),
});
const MAX_STEPS = Math.max(...Object.keys(SHAPES).map(Number));
/** The shape a tree's own banks pick: a step-4 or step-5 bank makes it five steps. */
const treeSteps = (banks) => (banks && typeof banks === 'object' && ('step4' in banks || 'step5' in banks) ? 5 : 3);
/** The shape a table's own paths pick, by their length, if any. */
const tableSteps = (table) => {
  const first = table?.paths && typeof table.paths === 'object' ? Object.keys(table.paths)[0] : undefined;
  return first && SHAPES[first.length] ? first.length : undefined;
};

const CaseTreeSchema = z.object({
  case_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must match /^[a-z0-9][a-z0-9-]{0,31}$/'),
  version: Text,
  event_code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/, 'must match /^[A-Z0-9][A-Z0-9-]{0,31}$/'),
  teaser: Bilingual,
  vignette: Bilingual,
  banks: z.union(Object.values(SHAPES).map((s) => s.banks)),
  admission: z.object({
    safety_review: z.object({ model: Text, date: CalendarDate, findings: Text, tree_sha256: Sha256.optional() }).strict().optional(),
    sandbox: z.object({ run_id: Text, date: CalendarDate, tree_sha256: Sha256.optional() }).strict().optional(),
    // The owner's waiver of the sandbox (ADR 0005): never of the safety review.
    owner_waiver: z.object({ date: CalendarDate, adr: z.literal('0005'), reason: Text, sandbox_run_id: Text, tree_sha256: Sha256.optional() }).strict().optional(),
    // ADR 0005's difficulty check on the path score table's own samples: a pass, written by the table build, or the
    // owner's waiver of a fail. Each names the table run it judged, so a rebuilt table needs its own.
    table_check: z.object({ run_id: Text, date: CalendarDate }).strict().optional(),
    table_waiver: z.object({ date: CalendarDate, adr: z.literal('0005'), reason: Text, run_id: Text }).strict().optional(),
  }).strict().optional(),
  // The demo score of each tier path (ADR 0009), built by scripts/booth/build-path-tables.mjs, never by hand.
  // Optional in the file so a case can be checked before its table is built; isAdmitted requires it.
  path_score_table: z.union(Object.values(SHAPES).map((s) => s.table)).optional(),
}).strict();

// The case schema with its banks of one shape and its table of one shape, each pair built once, for caseTreeProblems.
const SHAPED = Object.fromEntries(Object.entries(SHAPES).map(([steps, tree]) => [steps, Object.fromEntries(Object.entries(SHAPES)
  .map(([tabled, table]) => [tabled, CaseTreeSchema.extend({ banks: tree.banks, path_score_table: table.table.optional() })]))]));

/** Whether a case file may be dealt. Its safety review and its sandbox pass or owner waiver count only when bound to
 *  this tree by its hash, so a record never vouches for a tree it did not judge (#468, #470); its table vouches by its
 *  own run. The safety review's hash must also be the one its findings name (reviewedSha), so a tree_sha256 recomputed
 *  after an edit admits nothing (#386). Read on the raw file, the bytes those hashes were taken of. */
const isAdmitted = (raw) => {
  const a = raw?.admission;
  if (!a) return false;
  const sha = treeSha(raw);
  const bound = (record) => record?.tree_sha256 === sha;
  const run = raw.path_score_table?.provenance.run_id;
  return Boolean(bound(a.safety_review) && reviewedSha(a.safety_review.findings) === sha
    && (bound(a.sandbox) || bound(a.owner_waiver)) && run
    && (a.table_check?.run_id === run || a.table_waiver?.run_id === run));
};

/** A finished play's score, read from its case's path score table (ADR 0009): its tier path's domains, and their
 *  composite as the case's shape gives it. */
const tableScore = (kase, tierPath) => {
  const domains = kase.path_score_table.paths[tierPath];
  return { domains, composite: SHAPES[treeSteps(kase.banks)].composite(domains) };
};

// Thai combining marks take no width at the kiosk. Budgets are the line counts measured at the
// kiosk's font sizes (PR #233); the teaser budget is measured by scripts/booth/scenarios/draw.mjs.
const BUDGETS = {
  teaser: { th: 120, en: 180 },
  vignette: { th: 300, en: 450 },
  question: { th: 48, en: 80 },
  label: { th: 26, en: 36 },
  line: { th: 44, en: 70 },
};
const COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/gu;
const THAI = /[\u0E00-\u0E7F]/;
const width = { th: (s) => s.replace(COMBINING, '').length, en: (s) => s.length };
const OVERCLAIMS = ['on-premise', 'on premise', 'validated', 'ติดตั้งภายในองค์กร'];
// A word scan catches the wait-and-see class (holding treatment until a result). Nothing else
// guarantees the AI reply corrects such an option, since the booth prompt never names the best one.
const WITHHOLDS = {
  th: /เลี่ยง|งดยา|ชะลอ|เลื่อน|รอผล|รอดูอาการ|ยังไม่ให้|ไม่ให้ยา/,
  en: /\b(avoid\w*|withh[eo]ld\w*|delay\w*|defer\w*|postpon\w*|a?wait\w*|watchful|hold(?:ing)? off|until)\b/i,
};
// แต่ inside ตั้งแต่ (since), แต่ละ (each) or แต่ง (appoint) is not a "but".
const AGAINST = {
  th: /(?<!ตั้ง)แต่(?!ละ|ง)|ไม่/,
  en: /\b(but|not|no|unlikely|although|though|however|cannot|\w+n['’]t)\b/i,
};

const STOPWORDS = {
  en: new Set(['acute', 'chronic', 'disease', 'syndrome', 'with', 'from', 'and', 'the', 'due']),
  th: new Set(['โรค', 'ภาวะ', 'เฉียบพลัน', 'เรื้อรัง', 'จาก', 'และ', 'ใน', 'ของ']),
};
const thaiWords = new Intl.Segmenter('th', { granularity: 'word' });
// รอ (wait) only as a whole word: a substring scan would also flag รอย, รอบ and transliterations such as เซฟไตรอะโซน.
const waitWord = (s) => [...thaiWords.segment(s)].some((x) => x.segment === 'รอ') && 'รอ';
const words = {
  en: (s) => s.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.en.has(w)),
  th: (s) => [...thaiWords.segment(s.toLowerCase())]
    .filter((x) => x.isWordLike && x.segment.length >= 2 && !STOPWORDS.th.has(x.segment)).map((x) => x.segment),
};

const bankEntries = (k) => Object.entries(k.banks).flatMap(([step, level]) => (step === 'step1' ? [[`banks.${step}`, level]]
  : Object.entries(level).map(([key, bank]) => [`banks.${step}.${key}`, bank])));
const fields = (k) => [
  { kind: 'teaser', path: 'teaser', text: k.teaser },
  { kind: 'vignette', path: 'vignette', text: k.vignette },
  ...bankEntries(k).flatMap(([at, bank]) => [
    ...bank.variants.map((v, i) => ({ kind: 'question', path: `${at}.variants[${i}].question`, text: v.question })),
    ...bank.options.flatMap((o, i) => [
      { kind: 'label', path: `${at}.options[${i}].label`, text: o.label },
      { kind: 'line', path: `${at}.options[${i}].line`, text: o.line },
    ]),
  ]),
].flatMap(({ kind, path, text }) => LANGS.map((lang) => ({ kind, path, lang, s: text[lang] })));

const ANY = new Set(Object.keys(BUDGETS));
const RULES = [
  { applies: ANY, test: ({ lang, s }) => (lang === 'th' ? !THAI.test(s) && 'has no Thai script' : THAI.test(s) && 'has Thai script') },
  { applies: ANY, test: ({ kind, lang, s }) => width[lang](s) > BUDGETS[kind][lang] && `is ${width[lang](s)} characters (limit ${BUDGETS[kind][lang]})` },
  { applies: ANY, test: ({ s }) => { const w = OVERCLAIMS.find((x) => s.toLowerCase().includes(x)); return w && `overclaims ("${w}")`; } },
  // A booth question is one line: rimpl reads a tapped answer's turn by its first line (rimpl/src/routes/chat.js
  // boothTurnParts, #412).
  { applies: new Set(['question']), test: ({ s }) => /[\r\n\u2028\u2029]/.test(s) && 'holds a line break (a question is one line)' },
  { applies: new Set(['question', 'label', 'line']), test: ({ lang, s }) => { const m = s.match(WITHHOLDS[lang])?.[0] ?? (lang === 'th' && waitWord(s)); return m && `reads as withholding or delaying treatment ("${m}")`; } },
  { applies: new Set(['line']), test: ({ lang, s }) => { const m = s.match(AGAINST[lang]); return m && `argues against its own option ("${m[0]}")`; } },
  { applies: new Set(['teaser']), test: ({ lang, s }, { best }) => { const w = words[lang](s).find((x) => best[lang].has(x)); return w && `hints the step-1 best answer ("${w}")`; } },
];

const issuePath = (p) => p.reduce((at, k) => (typeof k === 'number' ? `${at}[${k}]` : at ? `${at}.${k}` : k), '') || '(case)';

/** Every shape and content problem in a raw case file, as "<path>: <message>". Empty means valid. */
function caseTreeProblems(raw) {
  // Checked against the one shape each part picks, so a problem names its field, not the union's "Invalid input".
  const steps = treeSteps(raw?.banks);
  const tabled = tableSteps(raw?.path_score_table) ?? steps;
  const parsed = SHAPED[steps][tabled].safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`);
  const kase = parsed.data;
  if (kase.path_score_table && tabled !== steps) {
    return [`path_score_table: is a ${tabled}-step table (${3 ** tabled} paths, method ${SHAPES[tabled].method}) on a ${steps}-step tree`];
  }
  // A table vouches only for the tree it was built from, which is the tree its safety review read (ADR 0009).
  if (kase.path_score_table && kase.path_score_table.provenance.tree_sha256 !== treeSha(raw)) {
    return ['path_score_table.provenance.tree_sha256: is not this tree\'s hash: the tree changed after its table was built, so it needs a new safety review and table'];
  }
  // The hash a safety review records is the mover's copy of the one its reviewer named in the findings (#386).
  const review = kase.admission?.safety_review;
  if (review?.tree_sha256 && reviewedSha(review.findings) !== review.tree_sha256) {
    return ['admission.safety_review.tree_sha256: is not the tree its findings name ("tree sha256 <hash>"): a tree edited after its review needs a new review, not a new hash'];
  }
  const bestLabels = kase.banks.step1.options.filter((o) => o.tier === 'best').map((o) => o.label);
  const ctx = { best: Object.fromEntries(LANGS.map((lang) => [lang, new Set(bestLabels.flatMap((l) => words[lang](l[lang])))])) };
  return fields(kase).flatMap((t) => RULES.filter((r) => r.applies.has(t.kind))
    .map((r) => r.test(t, ctx)).filter(Boolean).map((msg) => `${t.path}.${t.lang}: ${msg}`));
}

module.exports = { TIERS, MAX_STEPS, tierPaths, treeSteps, CaseTreeSchema, caseTreeProblems, isAdmitted, tableScore };
