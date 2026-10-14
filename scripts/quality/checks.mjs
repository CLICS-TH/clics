#!/usr/bin/env node
// checks.mjs — deterministic checks on every tutor reply in a tutor-audit report.
//
// Each check reuses the production rule it stands for, so a pass here means "production's own test
// passes", not "a re-implementation of it passes":
//   language     the production language guard — post-filter.js isThaiMessage + isLanguageMismatch
//                (#109): only a turn the physician wrote substantially in Thai is policed, and the
//                reply is measured AFTER stripNonProse (code, URLs, citations, artifacts, references)
//   citation     hasCitation                 — rimpl/src/services/post-filter.js (SHAPE only — see
//                                              cite-verify.mjs for whether the source is real)
//   socratic     extractSocraticQuestion     — post-filter.js (what chat.js enforces for examiner)
//   rescue       checkRescueReply            — rimpl/src/services/rescue.js (CREC082 §4 post-check)
//   evidence_marker  extractEvidenceLevel     — post-filter.js (CCME R5; only on a report run with
//                                              --evidence-marker, and never on a rescue turn — exactly
//                                              where chat.js checks it). Its placement is production's
//                                              evidenceMarkerPlaced — the rule chat.js now ENFORCES with
//                                              placeEvidenceLine — plus "no other evidence statement"
//                                              (findEvidenceStatements: near-misses the splice removes).
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

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  hasCitation, extractSocraticQuestion, extractReferences, checkRescueReply,
  thaiShare, stripNonProse, isThaiMessage, isLanguageMismatch, THAI_MIN_SHARE, MIN_JUDGED_LETTERS,
  stripThink, createThinkFilter,
  extractEvidenceLevel, findEvidenceMarkers, findEvidenceStatements, evidenceMarkerPlaced,
} from './rimpl.mjs';
import { routeLanguage, includesLoose } from './request.mjs';
import { wilson, fmtRate } from './stats.mjs';

// checks-v2 (2026-10-14): every check reads the reply production RETURNS — rimpl's stripThink applied
// to the served content (probe/lib.mjs chatCompletion; for a v1 report, applied here) — and
// no_reasoning_leak asks only what a physician could SEE: reasoning on screen in a streamed reply, or
// markup in the returned one. Inline markup production removes is an `info` flag, not a leak. A v1
// figure for no_reasoning_leak counted any <think> in the raw content and is not comparable.
// checks-v3 (2026-10-14): + evidence_marker / evidence_marker_placement (CCME R5), on --evidence-marker
// reports only. The value is production's level key — high | moderate | low | expert | not_graded — and
// "not graded" PASSES the shape check: it is a valid answer, not a missing one. An earlier report
// re-checked under v3 gains nothing: its entries carry no request.evidence_marker. Placement is
// production's evidenceMarkerPlaced and also fails when a second (near-miss) evidence statement is on
// screen; v3 has not been released (PR #153 open), so this refines v3 rather than starting a v4.
export const CHECKS_VERSION = 'checks-v3';
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
// Would a STREAMING physician have seen reasoning? Fed to production's own filter one character at a
// time — the finest a real stream can be cut — so this is the worst case of what reaches the screen.
// The one way it can: a block the chat template opened in the prompt (no <think>, a later </think>)
// on an instance without THINK_PREOPENED; whatever went out before that tag was the reasoning.
function streamedReasoningLeak(rawText, preopened) {
  if (!rawText || !/<\/think>/i.test(rawText)) return false;
  const f = createThinkFilter({ emit: () => {}, preopened });
  for (const ch of rawText) f.push(ch);
  f.end();
  return f.sawOrphanLeak();
}

export function checkReply(item, entry) {
  const final = entry.final ?? {};
  // `text` = the reply production RETURNS (and stores, and shows when not streaming); `raw_text` = the
  // content as served. A v1 report has no raw_text and its `text` IS the served content, so production's
  // rule is applied to it here — with the template default, since v1 runs had no THINK_PREOPENED.
  const hasRaw = typeof final.raw_text === 'string';
  const rawText = hasRaw ? final.raw_text : (typeof final.text === 'string' ? final.text : '');
  const preopened = !!final.think_preopened;
  const text = hasRaw ? (typeof final.text === 'string' ? final.text : '') : stripThink(rawText, { preopened });
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
  // Nothing but reasoning — in reasoning_content, or inline markup that strips to nothing.
  const reasoningOnly = !!final.reasoning_only || (empty && rawText.trim() !== '');
  checks.answered = { pass: !empty, detail: reasoningOnly ? 'no answer text: the reply was reasoning only' : undefined };
  if (empty) {
    flag(reasoningOnly ? 'reasoning_only' : 'empty_reply', 'critical',
      preopened && reasoningOnly
        ? 'the reply never closed its pre-opened reasoning block — rimpl answers with an error (reasoning_only)'
        : 'rimpl would show the physician a blank reply');
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

  // What a physician can actually SEE (v2). Not "the raw content contained <think>": production strips
  // that from the returned reply and withholds a model-opened block from a stream, so it never reaches
  // a screen. Two ways something can:
  //   returned  markup left in the reply production returns — a production bug if it ever happens;
  //   streamed  a template-opened block on an instance without THINK_PREOPENED — the pieces before the
  //             </think> were shown (streaming is the chat_streaming setting; this is its worst case).
  const returnedLeak = /<\/?think>/i.test(text);
  const streamedLeak = streamedReasoningLeak(rawText, preopened);
  checks.no_reasoning_leak = {
    pass: !returnedLeak && !streamedLeak,
    detail: returnedLeak ? 'the returned reply still carries <think> markup'
      : streamedLeak ? 'streamed, the reasoning before a </think> with no opening tag would be shown' : undefined,
  };
  if (returnedLeak) {
    flag('reasoning_leak', 'major', 'the reply production returns still contains <think> markup — chain-of-thought shown to the physician');
  } else if (streamedLeak) {
    flag('reasoning_leak', 'major', 'streamed, this reply would show its reasoning: the chat template opens the <think> block in the prompt. Set <PREFIX>THINK_PREOPENED=1 for this server, or (properly) run it with --reasoning-parser');
  }
  if (/<\/?think>/i.test(rawText) && !returnedLeak && !streamedLeak) {
    flag('reasoning_markup', 'info', 'the server put reasoning in `content`; rimpl removed it before anyone saw it — configure the server with --reasoning-parser');
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
    const cited = hasCitation(text);
    checks.citation_shape = { pass: cited, value: extractReferences(text).map((r) => r.source) };
    if (!cited) flag('no_citation', 'minor', 'no (Source, Year) citation after the chat.js retry');

    // EVIDENCE MARKER (CCME R5): present only when the run asked for it (entry.request.evidence_marker,
    // which runItem sets false on a rescue turn). Presence is production's parser — one marker line
    // outside any fence, else null — so a pass means chat.js would report a level. A SHAPE check only:
    // whether the level is the right GRADE certainty for the claim is for the judges and a clinician.
    if (entry.request?.evidence_marker === true) {
      const level = extractEvidenceLevel(text);
      const markers = findEvidenceMarkers(text);
      const why = markers.length > 1 ? `${markers.length} evidence lines (ambiguous)`
        : markers.length === 1 ? 'the Thai and English levels disagree' : 'no evidence-level line';
      checks.evidence_marker = { pass: level != null, value: level, detail: level ? `level ${level}` : why };
      if (level == null) {
        flag('no_evidence_marker', 'minor', `${why} after the chat.js retry`);
      } else {
        // The prompt's placement, as production defines it (post-filter evidenceMarkerPlaced): natural =
        // the very last line; examiner = directly above the closing ❓. chat.js moves a misplaced marker
        // (placeEvidenceLine), so a failure here is one it could not move — e.g. the move would have
        // dropped the reply's only citation — or a report from before that fix.
        const socratic = item.mode === 'examiner';
        const placed = evidenceMarkerPlaced(text, { socratic });
        const others = findEvidenceStatements(text).length - 1;   // near-miss statements beside the marker
        const rule = socratic ? 'directly above the closing ❓ line' : 'the last line';
        const detail = !placed ? `not ${rule}` : others > 0 ? `${rule}, but ${others} other evidence statement(s) on screen` : rule;
        checks.evidence_marker_placement = { pass: placed && others === 0, detail };
        if (!placed) flag('evidence_marker_misplaced', 'minor', `evidence line is not ${rule}`);
        if (others > 0) flag('evidence_statement_extra', 'minor', `${others} near-miss evidence statement(s) beside the marker`);
      }
    }
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
  return {
    checks_version: CHECKS_VERSION,
    n_items: results.length,
    n_assessable: assessable.length,
    n_call_failed: results.length - assessable.length,
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
