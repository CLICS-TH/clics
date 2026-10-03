#!/usr/bin/env node
/**
 * Plan 2.6: apply the PRE-REGISTERED adoption rule (AUTHORING.md §7 item 21) to a candidate local
 * addendum against the baseline, on the TUNING split. OFFLINE: it reads score-local reports and
 * calls nothing.
 *
 *   node scripts/calibration/anchors/addendum-compare.mjs \
 *     --baseline runs/a-h1.json,runs/a-h2.json --variant runs/b-h1.json,runs/b-h2.json [--out r.json]
 *
 * Each arm may be split over several report files (one invocation per half stays under the 2-hour
 * tool limit). The files of one arm must agree on model, prompt_version_used and rubric_version.
 * The two arms must have scored the same fixture bytes, and the rubric version must be the same in
 * both. Otherwise the comparison is refused, because it would compare two different things.
 *
 * Statistics come from known-groups.mjs (the same median-of-K, compositeOf and ICC(A,1) every other
 * anchor report uses), so a number here and a number there cannot disagree.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseScores, knownGroups, loadThreshold, DESIGN_PATH, EVIDENCE_LEVEL } from './known-groups.mjs';
import { loadAnchorSplit, splitFilter } from './anchor-split.mjs';
import { compositeOf, iccTwoRater } from '../../probe/agreement-stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// AUTHORING.md §7 item 21 — written before the tuning baseline returned a score.
export const RULE = Object.freeze({
  lowBand: 40,            // target composite below this is the low band
  highBand: 70,           // target composite at or above this is the high band
  lowBiasDropMin: 10,     // 1. |low-band bias| must fall by at least this
  highBiasMax: 7,         // 3. |high-band bias| must be at most this
  spearmanDropMax: 0.05,  // 4. composite Spearman may fall by at most this
  retestMin: 0.85,        // 5. test–retest ICC(A,1), run 1 vs run 2, at least this
  maxVariants: 3,
});

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Merge the report files of ONE arm into one score-local-shaped doc, refusing a provenance mixture. */
export function mergeArm(docs, label) {
  if (!docs.length) throw new Error(`${label}: no report files`);
  // Everything that changes what a score means must be identical across the files of one arm. A
  // half run with --consistency adaptive merged into an 'off' half would credit self-consistency to
  // the wording (the same class of error as the probe's 'median3 never ran').
  const keys = ['model', 'prompt_version_used', 'rubric_version', 'decoding', 'consistency', 'json_retries', 'contract'];
  for (const k of keys) {
    const vals = [...new Set(docs.map((d) => JSON.stringify(d[k] ?? null)))];
    if (vals.length !== 1) throw new Error(`${label}: report files disagree on ${k} (${vals.join(' vs ')})`);
  }
  const fixtures = {};
  for (const d of docs) for (const [id, sha] of Object.entries(d.fixtures ?? {})) {
    if (fixtures[id] && fixtures[id] !== sha) throw new Error(`${label}: ${id} scored on two different texts`);
    fixtures[id] = sha;
  }
  for (const d of docs) for (const r of d.rows ?? []) {
    if (r.scores && r.model && r.model !== d.model) throw new Error(`${label}: ${r.id} run ${r.run} was served by ${r.model}, not ${d.model}`);
  }
  const seen = new Set();
  for (const d of docs) for (const r of d.rows ?? []) {
    const k = `${r.id}#${r.run}`;
    if (seen.has(k)) throw new Error(`${label}: ${r.id} run ${r.run} appears twice`);
    seen.add(k);
  }
  return {
    probe: 'anchors-score-local', model: docs[0].model, prompt_version_used: docs[0].prompt_version_used,
    rubric_version: docs[0].rubric_version, addendum: docs[0].addendum ?? 'shipping',
    decoding: docs[0].decoding, consistency: docs[0].consistency, json_retries: docs[0].json_retries, contract: docs[0].contract,
    fixtures, rows: docs.flatMap((d) => d.rows ?? []),
  };
}

/** The numbers the rule reads, for one arm. */
export function armStats(design, doc, { threshold, allowedIds }) {
  const { runs, unscored, served } = normaliseScores(doc);
  const kg = knownGroups(design, runs, { threshold, allowedIds, served, fixtureShas: doc.fixtures });
  const band = (pred) => {
    const xs = kg.anchors.filter((x) => pred(x.target_composite));
    return { n: xs.length, bias: r2(mean(xs.map((x) => x.ai_composite - x.target_composite))) };
  };
  // Test–retest: composite of run 1 against composite of run 2, anchor by anchor.
  const byRun = (k) => new Map(doc.rows.filter((r) => r.run === k && r.scores).map((r) => [r.id, compositeOf(r.scores)]));
  const r1 = byRun(1), r2m = byRun(2);
  const pairs = [...r1.keys()].filter((id) => r2m.has(id) && allowedIds.has(id)).map((id) => ({ a: r1.get(id), b: r2m.get(id) }));
  const ai = kg.anchors.map((x) => x.ai_composite);
  return {
    prompt_version: doc.prompt_version_used,
    addendum: doc.addendum,
    n_designed: kg.n_designed,
    n_scored: kg.n_scored,
    unscored_rows: unscored,
    icc: kg.composite.icc,
    spearman: kg.composite.spearman,
    bias: kg.composite.bias,
    low: band((t) => t < RULE.lowBand),
    mid: band((t) => t >= RULE.lowBand && t < RULE.highBand),
    high: band((t) => t >= RULE.highBand),
    ai_range: ai.length ? [Math.min(...ai), Math.max(...ai)] : null,
    ai_sd: ai.length > 1 ? r2(Math.sqrt(ai.reduce((a, v) => a + (v - mean(ai)) ** 2, 0) / (ai.length - 1))) : null,
    flagged: kg.anchors.filter((x) => x.flagged).length,
    retest: iccTwoRater(pairs),
    per_domain_bias: Object.fromEntries(Object.entries(kg.per_domain).map(([d, v]) => [d, v.bias])),
  };
}

/** Apply the five pre-registered conditions. Every one must hold. */
export function adoption(base, cand) {
  const checks = [
    { id: 1, rule: `|low-band bias| falls by >= ${RULE.lowBiasDropMin}`,
      value: `${base.low.bias} -> ${cand.low.bias}`,
      pass: base.low.bias != null && cand.low.bias != null && Math.abs(base.low.bias) - Math.abs(cand.low.bias) >= RULE.lowBiasDropMin },
    { id: 2, rule: 'ICC(A,1) vs target point estimate is higher',
      value: `${r2(base.icc?.icc)} -> ${r2(cand.icc?.icc)}`,
      pass: base.icc?.icc != null && cand.icc?.icc != null && cand.icc.icc > base.icc.icc },
    { id: 3, rule: `|high-band bias| <= ${RULE.highBiasMax}`,
      value: `${cand.high.bias}`,
      pass: cand.high.bias != null && Math.abs(cand.high.bias) <= RULE.highBiasMax },
    { id: 4, rule: `Spearman drops by <= ${RULE.spearmanDropMax}`,
      value: `${r2(base.spearman?.rho)} -> ${r2(cand.spearman?.rho)}`,
      pass: base.spearman?.rho != null && cand.spearman?.rho != null && base.spearman.rho - cand.spearman.rho <= RULE.spearmanDropMax },
    { id: 5, rule: `test–retest ICC >= ${RULE.retestMin} and no unscored run`,
      value: `${r2(cand.retest?.icc)}, unscored ${cand.unscored_rows}`,
      pass: cand.retest?.icc != null && cand.retest.icc >= RULE.retestMin && cand.unscored_rows === 0 },
  ];
  return { checks, adopt: checks.every((c) => c.pass) };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const files = (name) => (flag(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const load = async (fs) => Promise.all(fs.map(async (f) => JSON.parse(await readFile(path.resolve(f), 'utf8'))));
  const baseFiles = files('baseline'), candFiles = files('variant');
  if (!baseFiles.length || !candFiles.length) {
    console.error('usage: addendum-compare.mjs --baseline a.json[,b.json] --variant c.json[,d.json] [--out r.json]');
    process.exit(2);
  }
  const design = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
  const threshold = await loadThreshold();
  const allowedIds = splitFilter(design, await loadAnchorSplit(), 'tuning');   // tuning only — never held-out
  const base = mergeArm(await load(baseFiles), 'baseline');
  const cand = mergeArm(await load(candFiles), 'variant');
  if (base.rubric_version !== cand.rubric_version) throw new Error(`rubric differs: ${base.rubric_version} vs ${cand.rubric_version}`);
  for (const k of ['model', 'decoding', 'consistency', 'json_retries', 'contract']) {
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(cand[k] ?? null)) throw new Error(`the arms differ on ${k}: only the addendum may differ`);
  }
  const heldOut = new Set((await loadAnchorSplit()).held_out);
  for (const doc of [base, cand]) for (const r of doc.rows) {
    if (heldOut.has(r.id)) throw new Error(`${r.id} is a HELD-OUT anchor: this tool compares tuning runs only, and a held-out score under a new prompt must not be hidden by filtering`);
  }
  if (base.prompt_version_used === cand.prompt_version_used) throw new Error('baseline and variant carry the same prompt version — nothing is being compared');
  const ids = new Set([...Object.keys(base.fixtures), ...Object.keys(cand.fixtures)]);
  for (const id of ids) if (base.fixtures[id] !== cand.fixtures[id]) throw new Error(`${id}: the arms scored different text (or only one arm scored it)`);

  const B = armStats(design, base, { threshold, allowedIds });
  const C = armStats(design, cand, { threshold, allowedIds });
  const verdict = adoption(B, C);
  const line = (k, b, c) => console.log(`  ${k.padEnd(22)} ${String(b).padEnd(26)} ${c}`);
  console.log(`addendum-compare — ${EVIDENCE_LEVEL}; tuning split, selection not validation`);
  line('', 'baseline', 'variant');
  line('prompt', B.prompt_version, C.prompt_version);
  line('n scored / designed', `${B.n_scored}/${B.n_designed}`, `${C.n_scored}/${C.n_designed}`);
  const ci = (x) => (x?.icc == null ? 'n/a' : `${r2(x.icc)} [${r2(x.lower)}, ${r2(x.upper)}]`);
  line('ICC(A,1) vs target', ci(B.icc), ci(C.icc));
  line('Spearman', r2(B.spearman?.rho), r2(C.spearman?.rho));
  line('bias (all)', B.bias, C.bias);
  line(`bias low (<${RULE.lowBand})`, `${B.low.bias} (n ${B.low.n})`, `${C.low.bias} (n ${C.low.n})`);
  line('bias mid', `${B.mid.bias} (n ${B.mid.n})`, `${C.mid.bias} (n ${C.mid.n})`);
  line(`bias high (>=${RULE.highBand})`, `${B.high.bias} (n ${B.high.n})`, `${C.high.bias} (n ${C.high.n})`);
  line('AI range / SD', `${B.ai_range?.join('–')} / ${B.ai_sd}`, `${C.ai_range?.join('–')} / ${C.ai_sd}`);
  line('flagged (>threshold)', B.flagged, C.flagged);
  line('test–retest ICC', ci(B.retest), ci(C.retest));
  line('unscored rows', B.unscored_rows, C.unscored_rows);
  console.log('\n  pre-registered adoption rule (AUTHORING.md §7 item 21):');
  for (const c of verdict.checks) console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}. ${c.rule}: ${c.value}`);
  console.log(`\n  ${verdict.adopt ? 'ADOPTABLE on tuning — still needs human validation (plan 2.7)' : 'NOT ADOPTED — the baseline stays'}`);
  const out = flag('out');
  if (out) {
    await writeFile(path.resolve(out), JSON.stringify({
      probe: 'anchors-addendum-compare', evidence_level: EVIDENCE_LEVEL, rule: RULE,
      baseline_files: baseFiles, variant_files: candFiles, baseline: B, variant: C, ...verdict,
    }, null, 2) + '\n');
    console.log(`  wrote ${out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
