#!/usr/bin/env node
// judge-merge.mjs — merge judge results (from ANY judge: a clinician, a Claude Code agent, the local
// model) into per-arm, per-dimension summaries, unblinded with the key from judge-packet.mjs.
//
// Reports, every rate with a Wilson 95% interval:
//   * THE GATE FIGURE (`gate`): one verdict per REPLY (item × arm), the MINIMUM over every judge and
//     both A/B orders, and the share of replies scoring >= 2 over n = the number of replies (80 for
//     the full bank). That is the unit docs/QUALITY-GATES.md pre-registers (e.g. 72/80). Counting
//     ratings instead — judges × orders × 80 — inflates n to >= 160 and narrows the interval for
//     free: at 70/80 acceptable replies the pre-registered lower bound is 0.785 (no-go) while a
//     ratings-level bound reads 0.815 (pass). A reply is critical-flagged if ANY judge flagged it in
//     ANY order;
//   * per judge: the same reply-level figures for that judge alone (min over its two orders);
//   * `ratings_secondary`: the old per-rating summary, kept only as a labelled secondary number;
//   * critical must-flag counts per flag code;
//   * pairwise runs: win / tie / loss, position bias (how often slot A is preferred — should be ~50%),
//     and order consistency (does the same item get the same verdict with A and B swapped?);
//   * with >= 2 judges: Cohen's kappa per dimension (unweighted and quadratic-weighted, since the
//     scale is ordinal), on preferences, and on "has a critical flag".
//
// EVIDENCE LEVEL: any non-human judge makes the whole merge "screening". A Claude judge may favour a
// Claude arm, and a local-model judge its own replies — the merge says so when the pairing exists.
//
// Usage:
//   node scripts/quality/judge-merge.mjs --key <dir>/key.do-not-share.json [--packets <dir>/packets.jsonl]
//        <results1.jsonl> [<results2.jsonl> …] [--out merged.json]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DIMENSIONS, MUST_FLAGS, RESULT_SCHEMA } from './judge-packet.mjs';
import { wilson, cohenKappa, fmtRate } from './stats.mjs';

const JUDGE_KINDS = ['human', 'claude-agent', 'local-model', 'other'];
const CRITICAL = new Set(Object.entries(MUST_FLAGS).filter(([, v]) => v.critical).map(([k]) => k));
const SCORE_CATS = [0, 1, 2, 3];

/** Validate one result line. Returns an array of error strings (empty = valid). */
export function validateResult(rec, { key, packetsById } = {}) {
  const errs = [];
  const e = (m) => errs.push(`${rec?.judge_id ?? '?'}/${rec?.packet_id ?? '?'}: ${m}`);
  if (!rec || typeof rec !== 'object') return ['result is not an object'];
  if (rec.schema !== undefined && rec.schema !== RESULT_SCHEMA) e(`schema must be ${RESULT_SCHEMA}`);
  if (typeof rec.packet_id !== 'string') e('packet_id required');
  if (typeof rec.judge_id !== 'string' || !rec.judge_id) e('judge_id required');
  if (!JUDGE_KINDS.includes(rec.judge_kind)) e(`judge_kind must be one of ${JUDGE_KINDS.join('|')}`);
  const kp = key?.packets?.[rec.packet_id];
  if (key && !kp) e('packet_id not in key');
  const slots = kp ? Object.keys(kp.slots) : ['A', 'B'];
  const applicable = packetsById?.get(rec.packet_id)?.applicable_dimensions;
  for (const slot of Object.keys(rec.scores ?? {})) if (!slots.includes(slot)) e(`scores has unknown slot ${slot}`);
  for (const slot of slots) {
    const s = rec.scores?.[slot];
    if (!s || typeof s !== 'object') { e(`scores.${slot} missing`); continue; }
    for (const [d, v] of Object.entries(s)) {
      if (!DIMENSIONS.includes(d)) e(`unknown dimension ${d}`);
      else if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 3)) e(`scores.${slot}.${d} must be 0-3 or null`);
      else if (applicable && !applicable.includes(d) && v !== null) e(`scores.${slot}.${d} must be null (not applicable)`);
    }
    if (applicable) for (const d of applicable) if (!(d in s)) e(`scores.${slot}.${d} missing`);
    const f = rec.must_flags?.[slot];
    if (!Array.isArray(f)) e(`must_flags.${slot} must be an array`);
    else for (const code of f) if (!(code in MUST_FLAGS)) e(`unknown must-flag ${code}`);
  }
  if (slots.length === 2) {
    if (!['A', 'B', 'tie'].includes(rec.preference)) e('pairwise packet: preference must be A, B or tie');
  } else if (rec.preference != null) {
    e('single-reply packet: preference must be null/absent');
  }
  return errs;
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function dimSummary(scores) {
  const dist = SCORE_CATS.map((c) => scores.filter((x) => x === c).length);
  return { n: scores.length, mean: mean(scores), dist, acceptable: wilson(scores.filter((x) => x >= 2).length, scores.length) };
}

/**
 * Merge validated results. Pure.
 * @param {{key:object, results:object[], packetsById?:Map}} input
 */
export function mergeJudgements({ key, results, packetsById }) {
  const errors = results.flatMap((r) => validateResult(r, { key, packetsById }));
  const seen = new Set();
  for (const r of results) {
    const k = `${r.judge_id}\0${r.packet_id}`;
    if (seen.has(k)) errors.push(`${r.judge_id}/${r.packet_id}: duplicate result`);
    seen.add(k);
  }
  if (errors.length) {
    const err = new Error(`invalid judge results:\n  ${errors.slice(0, 30).join('\n  ')}${errors.length > 30 ? `\n  … ${errors.length - 30} more` : ''}`);
    err.errors = errors;
    throw err;
  }

  const arms = key.arms.map((a) => a.arm);
  const judges = [...new Map(results.map((r) => [r.judge_id, r.judge_kind])).entries()].map(([id, kind]) => ({ id, kind }));
  // Unblind: one row per (judge, packet, slot) with the arm it belongs to.
  const rows = results.flatMap((r) => Object.entries(key.packets[r.packet_id].slots).map(([slot, arm]) => ({
    judge: r.judge_id, packet: r.packet_id, item: key.packets[r.packet_id].item_id, slot, arm,
    scores: r.scores[slot], flags: r.must_flags[slot] ?? [],
  })));

  const perArm = (subset) => Object.fromEntries(arms.map((arm) => {
    const rs = subset.filter((x) => x.arm === arm);
    const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, dimSummary(rs.map((x) => x.scores[d]).filter((v) => v !== null && v !== undefined))]).filter(([, s]) => s.n > 0));
    const flagCounts = {};
    for (const x of rs) for (const f of x.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    return [arm, {
      unit: 'ratings (judges × orders × replies) — secondary, NOT the gate figure',
      n_ratings: rs.length,
      dimensions: dims,
      critical_flag_rate: wilson(rs.filter((x) => x.flags.some((f) => CRITICAL.has(f))).length, rs.length),
      flag_counts: flagCounts,
    }];
  }));

  // Reply level: collapse every rating of one reply (item × arm) to ONE verdict — the lowest score per
  // dimension and the union of flags — then summarise over replies. See the header for why.
  const replyLevel = (subset) => {
    const byReply = new Map();
    for (const x of subset) {
      const key2 = `${x.item}\0${x.arm}`;
      const r = byReply.get(key2) ?? { arm: x.arm, flags: new Set(), min: {} };
      for (const f of x.flags) r.flags.add(f);
      for (const [d, v] of Object.entries(x.scores)) if (v != null) r.min[d] = Math.min(r.min[d] ?? 3, v);
      byReply.set(key2, r);
    }
    const replies = [...byReply.values()];
    return Object.fromEntries(arms.map((arm) => {
      const rs = replies.filter((r) => r.arm === arm);
      const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, dimSummary(rs.map((r) => r.min[d]).filter((v) => v !== undefined))]).filter(([, x]) => x.n > 0));
      return [arm, {
        unit: 'replies',
        n_replies: rs.length,
        dimensions: dims,
        critical_flag_rate: wilson(rs.filter((r) => [...r.flags].some((f) => CRITICAL.has(f))).length, rs.length),
      }];
    }));
  };
  const gate = replyLevel(rows);
  const byJudge = Object.fromEntries(judges.map((j) => [j.id, replyLevel(rows.filter((x) => x.judge === j.id))]));
  const ratingsSecondary = perArm(rows);

  // Per item × arm: every flag any judge raised and the LOWEST score any judge gave per dimension —
  // what clinician-export.mjs uses to decide which replies a clinician must read.
  const perItem = {};
  for (const x of rows) {
    const slot = ((perItem[x.item] ??= {})[x.arm] ??= { judges: [], flags: [], min_scores: {} });
    if (!slot.judges.includes(x.judge)) slot.judges.push(x.judge);
    for (const f of x.flags) if (!slot.flags.includes(f)) slot.flags.push(f);
    for (const [d, v] of Object.entries(x.scores)) {
      if (v == null) continue;
      slot.min_scores[d] = Math.min(slot.min_scores[d] ?? 3, v);
    }
  }

  let pairwise = null;
  if (key.pairwise) {
    pairwise = {};
    for (const j of judges) {
      const rs = results.filter((r) => r.judge_id === j.id);
      const verdict = (r) => (r.preference === 'tie' ? 'tie' : key.packets[r.packet_id].slots[r.preference]);
      const n = rs.length;
      const wins = rs.filter((r) => verdict(r) === arms[0]).length;
      const losses = rs.filter((r) => verdict(r) === arms[1]).length;
      const ties = n - wins - losses;
      const decided = rs.filter((r) => r.preference !== 'tie');
      // Order consistency: same item judged under both orders → same arm (or tie) both times?
      const byItem = new Map();
      for (const r of rs) {
        const id = key.packets[r.packet_id].item_id;
        (byItem.get(id) ?? byItem.set(id, []).get(id)).push(verdict(r));
      }
      const both = [...byItem.values()].filter((v) => v.length === 2);
      pairwise[j.id] = {
        comparison: `${arms[0]} vs ${arms[1]}`,
        n_packets: n,
        [`${arms[0]}_wins`]: wilson(wins, n),
        ties: wilson(ties, n),
        [`${arms[1]}_wins`]: wilson(losses, n),
        [`${arms[0]}_win_rate_excluding_ties`]: wilson(wins, wins + losses),
        position_bias_slot_A: wilson(decided.filter((r) => r.preference === 'A').length, decided.length),
        order_consistency: wilson(both.filter((v) => v[0] === v[1]).length, both.length),
      };
    }
  }

  let agreement = null;
  if (judges.length >= 2) {
    agreement = [];
    for (let a = 0; a < judges.length; a++) {
      for (let b = a + 1; b < judges.length; b++) {
        const ja = judges[a].id;
        const jb = judges[b].id;
        const idx = (j) => new Map(rows.filter((x) => x.judge === j).map((x) => [`${x.packet}\0${x.slot}`, x]));
        const A = idx(ja);
        const B = idx(jb);
        const common = [...A.keys()].filter((k) => B.has(k));
        const dims = {};
        for (const d of DIMENSIONS) {
          const pairs = common.map((k) => [A.get(k).scores[d], B.get(k).scores[d]]).filter(([x, y]) => x != null && y != null);
          if (!pairs.length) continue;
          dims[d] = {
            n: pairs.length,
            kappa: cohenKappa(pairs, { categories: SCORE_CATS }).kappa,
            kappa_quadratic: cohenKappa(pairs, { weights: 'quadratic', categories: SCORE_CATS }).kappa,
            exact_agreement: pairs.filter(([x, y]) => x === y).length / pairs.length,
          };
        }
        const critPairs = common.map((k) => [A.get(k).flags.some((f) => CRITICAL.has(f)), B.get(k).flags.some((f) => CRITICAL.has(f))]);
        let pref = null;
        if (key.pairwise) {
          const ra = new Map(results.filter((r) => r.judge_id === ja).map((r) => [r.packet_id, r]));
          const rb = new Map(results.filter((r) => r.judge_id === jb).map((r) => [r.packet_id, r]));
          const toArm = (r) => (r.preference === 'tie' ? 'tie' : key.packets[r.packet_id].slots[r.preference]);
          const pp = [...ra.keys()].filter((p) => rb.has(p)).map((p) => [toArm(ra.get(p)), toArm(rb.get(p))]);
          pref = { n: pp.length, kappa: cohenKappa(pp, { categories: [...arms, 'tie'] }).kappa };
        }
        agreement.push({
          judges: [ja, jb],
          dimensions: dims,
          critical_flag: { n: critPairs.length, kappa: cohenKappa(critPairs, { categories: [false, true] }).kappa },
          preference: pref,
        });
      }
    }
  }

  const kinds = new Set(judges.map((j) => j.kind));
  const caveats = [];
  if ([...kinds].some((k) => k !== 'human')) caveats.push('At least one judge is not a human clinician: these results are SCREENING evidence only. A clinician sign-off is required before serving real physicians (docs/QUALITY-GATES.md).');
  if (kinds.has('claude-agent') && key.arms.some((a) => a.provider === 'anthropic')) caveats.push('A Claude judge scored a Claude arm: possible self-preference bias. Compare against the local-model judge and, decisively, a clinician.');
  if (kinds.has('local-model') && key.arms.some((a) => a.provider === 'local')) caveats.push('A local-model judge scored a local arm: possible self-preference bias.');
  if (judges.length < 2) caveats.push('Only one judge: inter-judge agreement cannot be estimated.');

  return {
    schema: 'clics-tutor-judge-merge/v1',
    merged_at: new Date().toISOString(),
    rubric_version: key.rubric_version,
    evidence_level: [...kinds].every((k) => k === 'human') ? 'human-judged' : 'screening',
    arms: key.arms,
    judges,
    n_results: results.length,
    excluded_items: key.excluded,
    gate,
    per_judge: byJudge,
    ratings_secondary: ratingsSecondary,
    pairwise,
    agreement,
    per_item: perItem,
    caveats,
  };
}

export function printMerge(m, log = console.log) {
  log(`\n  judge merge — ${m.n_results} result(s) from ${m.judges.length} judge(s): ${m.judges.map((j) => `${j.id} (${j.kind})`).join(', ')}`);
  log(`  evidence level: ${m.evidence_level.toUpperCase()}`);
  for (const a of m.arms) log(`  ${a.arm} = ${a.label} (${a.provider ?? '?'} ${a.model ?? ''})`);
  for (const [arm, s] of Object.entries(m.gate)) {
    log(`\n  ${arm} — GATE FIGURE: ${s.n_replies} replies, one verdict each (lowest score over all judges and orders)`);
    for (const [d, x] of Object.entries(s.dimensions)) log(`    ${d.padEnd(18)} >=2: ${fmtRate(x.acceptable)} replies   (mean of lowest ${x.mean.toFixed(2)})`);
    log(`    ${'critical flag'.padEnd(18)} ${fmtRate(s.critical_flag_rate)} replies`);
    const r = m.ratings_secondary[arm];
    log(`    ${'(secondary)'.padEnd(18)} ${r.n_ratings} ratings — per-rating figures in merged.json ratings_secondary; never gate on them`);
  }
  if (m.pairwise) for (const [j, p] of Object.entries(m.pairwise)) {
    log(`\n  pairwise (${j}): ${p.comparison}`);
    for (const [k, v] of Object.entries(p)) if (v && typeof v === 'object') log(`    ${k.padEnd(34)} ${fmtRate(v)}`);
  }
  if (m.agreement) for (const a of m.agreement) {
    log(`\n  agreement ${a.judges.join(' × ')}`);
    for (const [d, x] of Object.entries(a.dimensions)) log(`    ${d.padEnd(18)} n=${x.n}  κ=${x.kappa?.toFixed(2) ?? '—'}  κw=${x.kappa_quadratic?.toFixed(2) ?? '—'}  exact ${(x.exact_agreement * 100).toFixed(0)}%`);
    log(`    ${'critical flag'.padEnd(18)} n=${a.critical_flag.n}  κ=${a.critical_flag.kappa?.toFixed(2) ?? '—'}`);
    if (a.preference) log(`    ${'preference'.padEnd(18)} n=${a.preference.n}  κ=${a.preference.kappa?.toFixed(2) ?? '—'}`);
  }
  for (const c of m.caveats) log(`\n  ⚠ ${c}`);
}

async function readJsonl(file) {
  return (await readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${file}:${i + 1}: ${e.message}`); }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : null; };
  const keyFile = flag('key');
  const files = args.filter((a, i) => !a.startsWith('--') && !['--key', '--packets', '--out'].includes(args[i - 1]));
  if (!keyFile || !files.length) {
    console.error('usage: node scripts/quality/judge-merge.mjs --key <key.do-not-share.json> [--packets packets.jsonl] <results.jsonl>… [--out merged.json]');
    process.exit(2);
  }
  const key = JSON.parse(await readFile(keyFile, 'utf8'));
  const packetsFile = flag('packets');
  const packetsById = packetsFile ? new Map((await readJsonl(packetsFile)).map((p) => [p.packet_id, p])) : undefined;
  const results = (await Promise.all(files.map(readJsonl))).flat();
  let merged;
  try { merged = mergeJudgements({ key, results, packetsById }); } catch (e) { console.error(e.message); process.exit(1); }
  printMerge(merged);
  const out = flag('out') ?? path.join(path.dirname(keyFile), 'merged.json');
  await writeFile(out, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`\n  written: ${out}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) await main();
