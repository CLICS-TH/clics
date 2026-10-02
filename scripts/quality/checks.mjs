#!/usr/bin/env node
// checks.mjs — deterministic checks on every tutor reply in a tutor-audit report.
//
// Each check reuses the production rule it stands for, so a pass here means "production's own test
// passes", not "a re-implementation of it passes":
//   language     the production language guard — post-filter.js isThaiMessage + isLanguageMismatch
//                (#109): only a turn the physician wrote substantially in Thai is policed, and the
//                reply is measured AFTER stripNonProse (code, URLs, citations, artifacts, references)
//   citation     meetsCitationRule           — rimpl/src/services/post-filter.js: a (Source, Year)
//                                              SHAPE (hasCitation) or the prompt's explicit "(no
//                                              specific source cited)" note — what chat.js's retry
//                                              enforces. Shape only; cite-verify.mjs says if it is real
//   socratic     extractSocraticQuestion     — post-filter.js (what chat.js enforces for examiner)
//   rescue       checkRescueReply            — rimpl/src/services/rescue.js (CREC082 §4 post-check)
//   length       "keep the whole reply under ~400 words" — rimpl/src/lib/prompts.js
// plus three this harness adds: echo of the item's synthetic identifiers, must_not_patterns, and an
// empty / reasoning-only reply (the DeepSeek-style failure rimpl renders as a blank bubble).
//
// None of this judges clinical correctness. These are screening checks; accuracy, harm and Thai
// quality are for the judges (judge-packet.mjs) and, decisively, a clinician (clinician-export.mjs).
//
// Usage:
//   node scripts/quality/checks.mjs scripts/quality/report/<label>.json           # print summary
//   node scripts/quality/checks.mjs scripts/quality/report/<label>.json --write   # also store checks in the report
//   node scripts/quality/checks.mjs <label>.json --cites <label>.cites.json        # + per-reply evidence coverage

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  hasCitation, hasNoSourceStatement, meetsCitationRule, extractSocraticQuestion, extractReferences, checkRescueReply,
  thaiShare, stripNonProse, isThaiMessage, isLanguageMismatch, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
} from './rimpl.mjs';
import { routeLanguage, includesLoose } from './request.mjs';
import { wilson, fmtRate, binomPmf, binomUpper } from './stats.mjs';

// v2: citation_shape passes on production's meetsCitationRule (a citation OR an explicit no-source
// note), not on hasCitation alone. Each non-rescue reply's citation FORM is recorded ('citation',
// 'citation+note', 'note-only', 'none'), the note-only rate is gated (NOTE_ONLY_MAX_UPPER), and with
// --cites the per-reply evidence coverage is computed. Not comparable with v1 on citation_shape for
// a reply that carries only the note.
export const CHECKS_VERSION = 'checks-v2';

// The note-only ceiling, pre-registered in docs/QUALITY-GATES.md (2026-10-02, before any run under the
// new prompt): the Wilson 95% UPPER bound of note-only / non-rescue replies must be <= 0.25. At n = 74
// that allows at most 11 note-only replies (11/74 = 14.9%, upper 24.7%; 12/74 has upper 26.2%).
export const NOTE_ONLY_MAX_UPPER = 0.25;

export const CITATION_FORMS = ['citation', 'citation+note', 'note-only', 'none'];

/** The citation form of one reply: does it carry a (Source, Year) shape, the no-source note, both? */
export function citationForm(text) {
  const cited = hasCitation(text);
  const note = hasNoSourceStatement(text);
  if (cited) return note ? 'citation+note' : 'citation';
  return note ? 'note-only' : 'none';
}
// prompts.js: "keep the whole reply under ~400 words". The tilde earns a 10% tolerance.
export const LENGTH_TARGET_WORDS = 400;
export const LENGTH_MAX_WORDS = 440;

export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
/** Word count that works for Thai (no spaces between words): ICU dictionary segmentation. */
export function wordCount(text) {
  let n = 0;
  for (const s of segmenter.segment(String(text ?? ''))) if (s.isWordLike) n += 1;
  return n;
}

/**
 * Run every applicable check on one reply.
 * @param {object} item   the bank item
 * @param {object} entry  the report entry: { final: {ok, text, reasoning_only, finish_reason, error},
 *                        request: {identifiers_sent}, retry }
 * @returns {{assessable:boolean, checks:Record<string,{pass:boolean|null, value?:any, detail?:string}>, flags:Array}}
 */
export function checkReply(item, entry) {
  const final = entry.final ?? {};
  const text = typeof final.text === 'string' ? final.text : '';
  const checks = {};
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });

  // Transport failure: not a verdict on the model's clinical quality, and excluded from the quality
  // denominators — but it IS a verdict on serving, so it is flagged and counted separately.
  if (!final.ok) {
    flag('call_failed', 'info', final.error || 'call failed');
    return { assessable: false, checks: { answered: { pass: false, detail: 'call failed' } }, flags };
  }
  const empty = !text.trim();
  checks.answered = { pass: !empty, detail: final.reasoning_only ? 'content empty, reasoning_content present' : undefined };
  if (empty) {
    flag(final.reasoning_only ? 'reasoning_only' : 'empty_reply', 'critical',
      'rimpl would show the physician a blank reply');
    return { assessable: true, checks, flags };
  }

  // LANGUAGE, as production's guard sees it. chat.js polices a turn only when the client labelled it
  // 'th' (any Thai codepoint) AND the physician's raw message is substantially Thai; the reply is
  // then measured on its prose only. A mismatch here is what production would DELIVER after its own
  // retry — so it is critical.
  const message = item.turns[item.turns.length - 1].content;
  const routeLang = routeLanguage(message);
  const prose = stripNonProse(text);
  const share = thaiShare(prose);
  const pct = `${(share * 100).toFixed(0)}% Thai in prose, cut ${THAI_MIN_SHARE}`;
  if (routeLang === 'th' && isThaiMessage(message)) {
    const mismatch = isLanguageMismatch(text, 'th');
    checks.language = { pass: !mismatch, value: Number(share.toFixed(3)), detail: `Thai turn: ${mismatch ? 'reply not Thai' : 'reply Thai (or too little prose to judge)'} (${pct})` };
    if (mismatch) flag('wrong_language', 'critical', checks.language.detail);
  } else if (routeLang === 'en') {
    // NOT policed by production (#109 never forces a language on an English turn). The bank still
    // expects an English question to get an English reply — the prompt says "reply in the same
    // language" — so this is reported, as major, with the same metric and the same exclusions.
    const letters = (prose.match(/[\u0E00-\u0E7FA-Za-z]/g) || []).length;
    const thaiReply = letters >= MIN_JUDGED_LETTERS && share >= THAI_MIN_SHARE;
    checks.english_reply = { pass: !thaiReply, value: Number(share.toFixed(3)), detail: `English turn (not policed in production): ${thaiReply ? 'reply in Thai' : 'reply English'} (${pct})` };
    if (thaiReply) flag('wrong_language_en', 'major', checks.english_reply.detail);
  } else {
    checks.language = { pass: null, value: Number(share.toFixed(3)), detail: 'labelled th but the physician wrote mostly English — production does not police this turn' };
  }

  const words = wordCount(text);
  checks.length = { pass: words <= LENGTH_MAX_WORDS, value: words, detail: `${words} words (target <~${LENGTH_TARGET_WORDS})` };
  if (words > LENGTH_MAX_WORDS) flag('too_long', 'minor', checks.length.detail);

  const truncated = final.finish_reason === 'length' || final.stop_reason === 'max_tokens';
  checks.not_truncated = { pass: !truncated };
  if (truncated) flag('truncated', 'major', 'finish_reason=length — the reply was cut off');

  if (/<\/?think>/i.test(text)) {
    checks.no_reasoning_leak = { pass: false };
    flag('reasoning_leak', 'major', 'reply contains <think> markup — chain-of-thought shown to the physician');
  } else {
    checks.no_reasoning_leak = { pass: true };
  }

  const socraticQ = extractSocraticQuestion(text);
  if (item.mode === 'examiner') {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    checks.socratic_close = { pass: socraticQ != null, value: socraticQ };
    checks.socratic_last_line = { pass: lines.length > 0 && lines[lines.length - 1].startsWith('❓') };
    if (socraticQ == null) flag('no_socratic_question', 'major', 'examiner reply has no ❓ line (after the chat.js retry)');
  } else if (item.mode === 'natural') {
    checks.no_socratic_in_natural = { pass: socraticQ == null };
    if (socraticQ != null) flag('socratic_in_natural', 'minor', 'natural-mode reply appended a ❓ question the prompt forbids');
  }

  if (item.mode === 'rescue') {
    const r = checkRescueReply(text);
    checks.rescue_reply = { pass: r.ok, value: r };
    if (!r.ok) {
      const why = [r.noQuestion && 'no question', r.tooManyQuestions && `${r.questions} questions (max 2)`, r.diagnostic && 'diagnostic/recommending language'].filter(Boolean).join(', ');
      flag('rescue_violation', 'major', `rescue post-check failed: ${why}`);
    }
  } else {
    // Production's rule, as chat.js's retry enforces it: a (Source, Year) citation OR the explicit
    // "(no specific source cited)" note the prompt asks for instead of an invented reference. The
    // note is honest, not a defect, so it passes. But a model that wrote it everywhere would pass too,
    // so the FORM is recorded and the note-only rate is gated in summarize(). A reply with the note
    // AND a citation is a different thing (it cited what it could) and is counted separately.
    const form = citationForm(text);
    checks.citation_shape = {
      pass: meetsCitationRule(text),
      value: extractReferences(text).map((r) => r.source),
      form,
    };
    if (!checks.citation_shape.pass) flag('no_citation', 'minor', 'neither a (Source, Year) citation nor a no-specific-source note after the chat.js retry');
    if (form === 'note-only') flag('no_source_note_only', 'info', 'no-specific-source note and no (Source, Year) citation');
    if (form === 'citation+note') flag('no_source_with_citation', 'info', 'citation(s) plus a no-specific-source note for another point');
  }

  const ids = item.identifiers ?? [];
  if (ids.length) {
    const echoed = ids.filter((id) => includesLoose(text, id));
    checks.no_identifier_echo = { pass: echoed.length === 0, value: echoed };
    if (echoed.length) flag('pii_echo', 'critical', `reply repeats synthetic identifier(s): ${echoed.join(', ')}`);
    const sent = entry.request?.identifiers_sent ?? [];
    if (sent.length) {
      // The production PII filter let these through to the model. A filter gap, not a model fault —
      // reported so it is not mistaken for one, and so it is not lost either.
      flag('pii_filter_gap', 'info', `identifier(s) survived rimpl's PII filter into the request: ${sent.join(', ')}`);
    }
  }

  const pats = item.must_not_patterns ?? [];
  if (pats.length) {
    const hits = pats.filter((p) => new RegExp(p, 'iu').test(text));
    checks.must_not_patterns = { pass: hits.length === 0, value: hits };
    if (hits.length) flag('must_not_pattern', 'critical', `reply matches forbidden pattern(s): ${hits.join(' | ')}`);
  }

  if (entry.retry) flag('retry_used', 'info', `chat.js retry fired (${entry.retry.reason})`);
  return { assessable: true, checks, flags };
}

/** Per-check pass rates (Wilson 95%) over assessable replies, overall and by language and mode. */
export function summarize(results) {
  const assessable = results.filter((r) => r.result.assessable);
  const names = [...new Set(assessable.flatMap((r) => Object.keys(r.result.checks)))];
  const rate = (rows, name) => {
    const applicable = rows.filter((r) => r.result.checks[name] && r.result.checks[name].pass !== null);
    return wilson(applicable.filter((r) => r.result.checks[name].pass).length, applicable.length);
  };
  const by = (key) => {
    const groups = {};
    for (const r of assessable) (groups[r[key]] ??= []).push(r);
    return Object.fromEntries(Object.entries(groups).map(([g, rows]) =>
      [g, Object.fromEntries(names.map((n) => [n, rate(rows, n)]).filter(([, w]) => w.n > 0))]));
  };
  const flagCounts = {};
  for (const r of results) for (const f of r.result.flags) {
    flagCounts[f.code] ??= { severity: f.severity, items: [] };
    flagCounts[f.code].items.push(r.id);
  }
  const critical = results.filter((r) => r.result.flags.some((f) => f.severity === 'critical'));
  // Citation forms over the replies held to the citation rule (non-rescue, assessable). Note-only is
  // gated; note+citation is reported. Both use the same denominator as citation_shape.
  const cited = assessable.filter((r) => r.result.checks.citation_shape?.form);
  const forms = Object.fromEntries(CITATION_FORMS.map((f) => [f, cited.filter((r) => r.result.checks.citation_shape.form === f).length]));
  const noteOnly = wilson(forms['note-only'], cited.length);
  return {
    checks_version: CHECKS_VERSION,
    n_items: results.length,
    n_assessable: assessable.length,
    n_call_failed: results.length - assessable.length,
    citation_forms: { n: cited.length, ...forms },
    note_only_rate: noteOnly,
    note_with_citation_rate: wilson(forms['citation+note'], cited.length),
    // Pre-registered ceiling: the UPPER bound must stay <= NOTE_ONLY_MAX_UPPER. null when nothing is held to it.
    note_only_gate: cited.length
      ? { max_upper: NOTE_ONLY_MAX_UPPER, pass: noteOnly.hi <= NOTE_ONLY_MAX_UPPER }
      : { max_upper: NOTE_ONLY_MAX_UPPER, pass: null },
    overall: Object.fromEntries(names.map((n) => [n, rate(assessable, n)])),
    by_language: by('language'),
    by_mode: by('mode'),
    flags: flagCounts,
    items_with_critical: critical.map((r) => r.id),
    // "Zero critical flags" is the gate. Its Wilson upper bound says how much that zero is worth at
    // this n: 0/80 still allows a true rate up to ~4.6%.
    critical_rate: wilson(critical.length, assessable.length),
  };
}

/**
 * Per-REPLY evidence coverage (C-1, pre-registered 2026-10-02): of the replies held to the citation
 * rule (non-rescue, assessable), how many carry at least one citation cite-verify marks `verified`.
 * The per-CITATION verified rate cannot see opting out — a reply that cites nothing leaves its
 * denominator — so the two are always reported together.
 *   results  checkReport(...).results  (id, mode, result.assessable)
 *   cites    a <label>.cites.json from cite-verify.mjs ({ summary.verified_rate, items[{ id, citations[{ status }] }] })
 */
export function evidenceCoverage(results, cites) {
  const byId = new Map((cites?.items ?? []).map((it) => [it.id, it]));
  const held = results.filter((r) => r.mode !== 'rescue' && r.result.assessable);
  const missing = held.filter((r) => !byId.has(r.id)).map((r) => r.id);
  const covered = held.filter((r) => (byId.get(r.id)?.citations ?? []).some((c) => c.status === 'verified'));
  return {
    per_reply: wilson(covered.length, held.length),
    per_citation: cites?.summary?.verified_rate ?? null,
    covered: covered.map((r) => r.id),
    missing_from_cites: missing,
  };
}

// --- Before/after verdict on per-reply evidence coverage (C-1) ---------------------------------------
//
// AMENDED 2026-10-02 (docs/QUALITY-GATES.md, before any after-run existed). The first rule compared
// the after-run's Wilson interval with the baseline's POINT estimate, treating one n=74 run as exact.
// Its real error rates under "no change" were 9-10% false "improved" and ~7.5% false "worse", not the
// ~2.5% it claimed. The rule is now an exact one-sided McNemar test: both runs answer the SAME bank
// items, so the design is paired and only the items whose coverage changed carry information.
export const MCNEMAR_ALPHA = 0.025;   // per direction

/**
 * Exact one-sided McNemar on the discordant pairs. Under "no change" a discordant item is equally
 * likely to be a gain or a loss, so gained ~ Binomial(gained + lost, 1/2).
 *   p_improved = P(B >= gained)    p_worse = P(B <= gained) = P(B >= lost)
 * Verdict at `alpha` per direction; with no discordant pair nothing can be shown.
 */
export function mcnemarExact(gained, lost, alpha = MCNEMAR_ALPHA) {
  if (![gained, lost].every((x) => Number.isInteger(x) && x >= 0)) throw new RangeError(`mcnemarExact: counts must be integers >= 0, got ${gained}, ${lost}`);
  const n = gained + lost;
  const p_improved = binomUpper(gained, n);
  const p_worse = binomUpper(lost, n);
  const verdict = p_improved <= alpha ? 'improved' : p_worse <= alpha ? 'worse' : 'not-shown';
  return { gained, lost, n_discordant: n, p_improved, p_worse, alpha, verdict };
}

/**
 * Which items a run holds to the citation rule and covers. An item is usable only if it is
 * non-rescue, the call succeeded (assessable), and the cites file lists it.
 */
function coverageById(results, cites) {
  const citesById = new Map((cites?.items ?? []).map((it) => [it.id, it]));
  const out = new Map();
  for (const r of results) {
    let status;
    if (r.mode === 'rescue') status = 'rescue';
    else if (!r.result.assessable) status = 'call_failed';
    else if (!citesById.has(r.id)) status = 'missing_from_cites';
    else status = citesById.get(r.id).citations.some((c) => c.status === 'verified') ? 'covered' : 'not_covered';
    out.set(r.id, status);
  }
  return out;
}

/**
 * The paired before/after comparison for ONE arm. `before` and `after` are { results, cites }:
 * checkReport(...).results and a cite-verify .cites.json, for any two runs. Items are paired by id;
 * an item is excluded if EITHER side is rescue, a failed call, absent from that run, or absent from
 * that run's cites file. The paired n is reported, with why each excluded item was dropped.
 */
export function pairedCoverage(before, after, alpha = MCNEMAR_ALPHA) {
  const b = coverageById(before.results, before.cites);
  const a = coverageById(after.results, after.cites);
  const cells = { both: 0, gained: 0, lost: 0, neither: 0 };
  const excluded = [];
  for (const id of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const sb = b.get(id) ?? 'absent';
    const sa = a.get(id) ?? 'absent';
    const usable = (s) => s === 'covered' || s === 'not_covered';
    if (!usable(sb) || !usable(sa)) {
      // Rescue items are excluded by design; only report the others, which say something about a run.
      if (sb !== 'rescue' && sa !== 'rescue') excluded.push({ id, before: sb, after: sa });
      continue;
    }
    const was = sb === 'covered';
    const now = sa === 'covered';
    cells[was && now ? 'both' : now ? 'gained' : was ? 'lost' : 'neither'] += 1;
  }
  const n = cells.both + cells.gained + cells.lost + cells.neither;
  return {
    n_paired: n,
    ...cells,
    before: wilson(cells.both + cells.lost, n),
    after: wilson(cells.both + cells.gained, n),
    excluded,
    ...mcnemarExact(cells.gained, cells.lost, alpha),
  };
}

/**
 * Exact rejection rates of the McNemar rule for n paired items whose cells are independent draws with
 * P(gain) = pGain and P(loss) = pLoss: the number of discordant items is Binomial(n, pGain + pLoss)
 * and, given it, the gains are Binomial(d, pGain / (pGain + pLoss)). With pGain = pLoss this is the
 * false-verdict rate under "no change"; otherwise it is the power.
 */
export function mcnemarRejectRates(n, pGain, pLoss, alpha = MCNEMAR_ALPHA) {
  const pd = pGain + pLoss;
  const dPmf = binomPmf(n, pd);
  let improved = 0;
  let worse = 0;
  for (let d = 1; d <= n; d++) {
    if (dPmf[d] < 1e-300) continue;
    const gPmf = binomPmf(d, pGain / pd);
    for (let g = 0; g <= d; g++) {
      const v = mcnemarExact(g, d - g, alpha).verdict;
      if (v === 'improved') improved += dPmf[d] * gPmf[g];
      else if (v === 'worse') worse += dPmf[d] * gPmf[g];
    }
  }
  return { improved, worse };
}

/** Recompute checks for a whole report against the given bank items (by id). */
export function checkReport(report, bankById) {
  const missing = [];
  const results = [];
  for (const entry of report.items) {
    const item = bankById.get(entry.id);
    if (!item) { missing.push(entry.id); continue; }
    results.push({ id: entry.id, language: item.language, mode: item.mode, result: checkReply(item, entry) });
  }
  return { results, missing };
}

export function printSummary(summary, log = console.log) {
  log(`\n  deterministic checks (${summary.checks_version}) — ${summary.n_assessable}/${summary.n_items} replies assessable` +
    (summary.n_call_failed ? `, ${summary.n_call_failed} call failure(s) excluded` : ''));
  for (const [name, w] of Object.entries(summary.overall)) log(`    ${name.padEnd(24)} ${fmtRate(w)}`);
  log(`    ${'critical-flag rate'.padEnd(24)} ${fmtRate(summary.critical_rate)}`);
  if (summary.citation_forms?.n) {
    const f = summary.citation_forms;
    log(`\n  citation forms (non-rescue, n=${f.n}): citation ${f.citation}, citation+note ${f['citation+note']}, note-only ${f['note-only']}, none ${f.none}`);
    const g = summary.note_only_gate;
    log(`    ${'note-only (gated)'.padEnd(24)} ${fmtRate(summary.note_only_rate)}  upper <= ${g.max_upper}: ${g.pass ? 'pass' : 'FAIL'}`);
    log(`    ${'note+citation'.padEnd(24)} ${fmtRate(summary.note_with_citation_rate)}`);
  }
  if (summary.evidence_coverage) {
    const e = summary.evidence_coverage;
    log(`\n  evidence (from ${e.cites_file})`);
    log(`    ${'per reply: >=1 verified'.padEnd(24)} ${fmtRate(e.per_reply)}`);
    if (e.per_citation) log(`    ${'per citation: verified'.padEnd(24)} ${fmtRate(e.per_citation)}`);
    if (e.missing_from_cites.length) log(`    ⚠ ${e.missing_from_cites.length} reply(ies) absent from the cites file: ${e.missing_from_cites.join(', ')}`);
  }
  const sev = Object.entries(summary.flags).sort((a, b) =>
    SEVERITY_ORDER.indexOf(a[1].severity) - SEVERITY_ORDER.indexOf(b[1].severity));
  if (sev.length) {
    log('\n  flags');
    for (const [code, { severity, items }] of sev) log(`    ${severity.padEnd(8)} ${code.padEnd(20)} ${items.length}  ${items.slice(0, 8).join(', ')}${items.length > 8 ? ', …' : ''}`);
  }
  log('\n  Screening only: these checks cannot see clinical correctness. See docs/QUALITY-GATES.md.');
}

/* --------------------------------------------------------------------- CLI */

async function main() {
  const { loadBank } = await import('./bank.mjs');
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/quality/checks.mjs <report.json> [--write]');
    process.exit(2);
  }
  const report = JSON.parse(await readFile(file, 'utf8'));
  const { items } = await loadBank();
  const { results, missing } = checkReport(report, new Map(items.map((it) => [it.id, it])));
  if (missing.length) console.log(`  ⚠ ${missing.length} report item(s) not in the current bank (skipped): ${missing.join(', ')}`);
  const summary = summarize(results);
  const citesAt = rest.indexOf('--cites');
  if (citesAt !== -1) {
    const citesFile = rest[citesAt + 1];
    if (!citesFile) { console.error('--cites needs a <label>.cites.json path'); process.exit(2); }
    const cites = JSON.parse(await readFile(citesFile, 'utf8'));
    const { covered, ...cov } = evidenceCoverage(results, cites);
    summary.evidence_coverage = { cites_file: citesFile, ...cov };
  }
  printSummary(summary);
  if (rest.includes('--write')) {
    const byId = new Map(results.map((r) => [r.id, r.result]));
    for (const e of report.items) if (byId.has(e.id)) e.checks = byId.get(e.id);
    report.checks_summary = summary;
    await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\n  checks written into ${file}`);
  }
  process.exit(summary.items_with_critical.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
