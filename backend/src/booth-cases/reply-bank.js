// A five-step case's reply bank (ADR 0011, #382): the reviewed replies a tapped answer gets at once, with no AI call.
// It sits beside its case at <EVENT>/replies/<case_id>.json and is bound to the case's tree by hash, so a tree edit
// strands it until it is written and reviewed again. One entry per (bank, chosen option, language) holds 3
// alternatives, and every question variant of that bank shares them: a variant rewords its bank's question, and a reply
// comments only on the chosen option's own words (rimpl's booth rules), so the reply for every
// (bank, variant, option, language) key of ADR 0011 is one of its entry's three.
const { createHash } = require('crypto');
const { z } = require('zod');
const { canonical, treeSha, reviewedSha } = require('./tree-sha');
const { REPLY_FIELDS, comparable, checkedField } = require('../services/booth-dialogue');

const LANGS = ['th', 'en'];
const ALTERNATIVES = 3;
const THAI = /[฀-๿]/;

const Field = z.string();
const Reply = z.object(Object.fromEntries(REPLY_FIELDS.map((k) => [k, Field]))).strict();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const ReplyBankSchema = z.object({
  case_id: z.string(),
  replies: z.record(z.string(), z.record(z.string(), z.object(Object.fromEntries(LANGS.map((l) => [l, z.array(Reply)]))).strict())),
  safety_review: z.object({
    model: z.string().trim().min(1),
    date: CalendarDate,
    findings: z.string().trim().min(1),
    tree_sha256: Sha256,
    replies_sha256: Sha256,
  }).strict().optional(),
}).strict();

const repliesSha = (replies) => createHash('sha256').update(canonical(replies)).digest('hex');

// The replies a review read, in its reviewer's own words, as tree-sha.js reviewedSha reads the tree: undefined unless
// the findings name exactly one.
const REPLIES_NAMED = /\breplies sha256 ([0-9a-f]{64})(?![0-9a-f])/gi;
const reviewedRepliesSha = (findings) => {
  const named = new Set([...String(findings ?? '').matchAll(REPLIES_NAMED)].map((m) => m[1].toLowerCase()));
  return named.size === 1 ? [...named][0] : undefined;
};

/** Every bank of a case as [key, bank], the key as booth-dialogue bankKey names it ("step1", "step2.B"). */
const banksOf = (kase) => Object.entries(kase.banks).flatMap(([step, level]) => (Array.isArray(level.variants) ? [[step, level]]
  : Object.entries(level).map(([k, bank]) => [`${step}.${k}`, bank])));

const plain = (s) => comparable(s.replaceAll('**', ''));
// Whole numbers as written (7.15, 120, 3), so "12" is not found inside "120".
const numbers = (s) => new Set(s.match(/\d+(?:[.,]\d+)*/g) ?? []);
// Latin words of five letters or more, in either language's text (a Thai field names a drug or test in Latin too:
// CPAP, NT-proBNP). Thai has no word-level rule: its word segments (และ, ให้, ส่ง) are too common to tell an option
// apart, so a Thai field is held to the whole-label rule and the safety review.
const COMMON = new Set(['acute', 'chronic', 'their', 'there', 'these', 'those', 'which', 'while', 'about', 'after', 'before', 'other', 'first', 'again', 'still', 'patient']);
const latinWords = (s) => new Set(plain(s).match(/[a-z][a-z0-9-]{4,}/g)?.filter((w) => !COMMON.has(w)) ?? []);

/** Every problem in the replies themselves, as "<path>: <message>": a key missing or extra, an entry without exactly
 *  three distinct alternatives, a field over the cap or with a bold run that quotes anything but the chosen option's
 *  own label or line (rimpl's booth rule), a field in the wrong script, or a reply that names another option. */
function replyContentProblems(kase, replies) {
  const problems = [];
  const banks = banksOf(kase);
  const own = new Set(banks.map(([key]) => key));
  for (const key of Object.keys(replies)) if (!own.has(key)) problems.push(`replies.${key}: is not a bank of this case`);
  for (const [key, bank] of banks) {
    const entries = replies[key];
    if (!entries) { problems.push(`replies.${key}: is missing`); continue; }
    for (const id of Object.keys(entries)) {
      if (!bank.options.some((o) => o.id === id)) problems.push(`replies.${key}.${id}: is not an option of this bank`);
    }
    for (const option of bank.options) {
      const at = `replies.${key}.${option.id}`;
      const entry = entries[option.id];
      if (!entry) { problems.push(`${at}: is missing`); continue; }
      const said = LANGS.flatMap((l) => [option.label[l], option.line[l]]).map(comparable);
      const quotes = (run) => { const q = comparable(run); return said.some((s) => s.includes(q)); };
      // An option whose label the chosen option's own words hold ("O2, IV furosemide, antibiotic" inside "… 2
      // antibiotics") may be quoted, and so may any word the case already shows with this question.
      const rest = bank.options.filter((o) => o.id !== option.id);
      const others = rest.flatMap((o) => LANGS.map((l) => comparable(o.label[l]))).filter((label) => !said.some((s) => s.includes(label)));
      const shown = latinWords([...said, ...LANGS.flatMap((l) => [kase.vignette[l], ...bank.variants.map((v) => v.question[l])])].join(' '));
      const theirs = [...latinWords(rest.flatMap((o) => LANGS.map((l) => o.label[l])).join(' '))].filter((w) => !shown.has(w));
      // A reply serves every variant of its bank, so it never cites a number that some variants show and others do
      // not (unless the vignette or the chosen option shows it): a visitor dealt another variant never saw it. A
      // number no variant shows, such as a guideline's time window, is the safety review's to judge.
      const variantNumbers = bank.variants.map((v) => numbers(LANGS.map((l) => v.question[l]).join(' ')));
      const shownAlways = numbers(LANGS.flatMap((l) => [kase.vignette[l], option.label[l], option.line[l]]).join(' '));
      const partial = new Set(variantNumbers.flatMap((set) => [...set])
        .filter((n) => !shownAlways.has(n) && !variantNumbers.every((set) => set.has(n))));
      for (const lang of LANGS) {
        const alts = entry[lang];
        if (alts.length !== ALTERNATIVES) problems.push(`${at}.${lang}: has ${alts.length} alternatives (needs ${ALTERNATIVES})`);
        if (new Set(alts.map((r) => canonical(r))).size !== alts.length) problems.push(`${at}.${lang}: repeats an alternative`);
        alts.forEach((reply, i) => {
          for (const field of REPLY_FIELDS) {
            const text = reply[field];
            const where = `${at}.${lang}[${i}].${field}`;
            if (text === '') {
              if (field !== 'safety') problems.push(`${where}: is empty`);
              continue;
            }
            if (checkedField(text, quotes) !== text) {
              problems.push(`${where}: is not as the server shows it (over the cap, spacing, or a bold run that quotes beyond the chosen option)`);
            }
            if (lang === 'th' ? !THAI.test(text) : THAI.test(text)) problems.push(`${where}: ${lang === 'th' ? 'has no' : 'has'} Thai script`);
            const words = latinWords(text);
            const named = others.find((label) => plain(text).includes(label)) ?? theirs.find((w) => words.has(w));
            if (named) problems.push(`${where}: names another option ("${named}")`);
            const unseen = [...numbers(text)].find((n) => partial.has(n));
            if (unseen) problems.push(`${where}: cites ${unseen}, which only some question variants of this bank show`);
          }
        });
      }
    }
  }
  return problems;
}

/** Every problem in a reply bank file for `kase`: its shape, its content, and its safety review, which counts only
 *  while it is bound by hash to this tree and these replies and its findings name both (#386's rule for a tree). A
 *  bank without a review is a problem: it is never shown. */
function replyBankProblems(kase, file) {
  const parsed = ReplyBankSchema.safeParse(file);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(reply bank)'}: ${i.message}`);
  const bank = parsed.data;
  const problems = bank.case_id === kase.case_id ? [] : [`case_id: is ${bank.case_id}, not ${kase.case_id}`];
  problems.push(...replyContentProblems(kase, bank.replies));
  const review = bank.safety_review;
  if (!review) return [...problems, 'safety_review: is missing'];
  const tree = treeSha(kase);
  const sha = repliesSha(bank.replies);
  if (review.tree_sha256 !== tree || reviewedSha(review.findings) !== tree) {
    problems.push(`safety_review: does not bind this tree (tree_sha256 and the findings' "tree sha256 <hash>" must both be ${tree})`);
  }
  if (review.replies_sha256 !== sha || reviewedRepliesSha(review.findings) !== sha) {
    problems.push(`safety_review: does not bind these replies (replies_sha256 and the findings' "replies sha256 <hash>" must both be ${sha})`);
  }
  return problems;
}

module.exports = { ALTERNATIVES, repliesSha, replyContentProblems, replyBankProblems };
