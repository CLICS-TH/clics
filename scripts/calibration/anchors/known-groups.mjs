#!/usr/bin/env node
/*
 * Known-groups validity on the anchor cohort: does the evaluator's score track the DESIGNED target?
 * OFFLINE — reads a scores file and design.json, calls nothing.
 *
 *   node scripts/calibration/anchors/known-groups.mjs <scores.json> [--pilot] [--arm local|cloud] [--out report.json]
 *     --pilot   restrict the designed set to the 20 pilot anchors (so n_missing means something)
 *     --split tuning|heldout   restrict to one half of SPLIT-anchors.json; REQUIRED once that file
 *               exists (anchor-split.mjs). The pilot is tuning-only and never in held-out.
 *
 * <scores.json> may be any of:
 *   - score-local.mjs output           {probe, model, prompt_version, rows:[{id, run, scores|null, …}]}
 *   - scripts/probe/model-agreement.mjs  {rows:[{id, local, cloud, …}]}   (pick the arm with --arm)
 *   - a plain list                      [{id, scores:{d1..d7}}]           (repeat an id for K runs)
 *
 * WHAT IT COMPUTES — the pre-registered analysis in AUTHORING.md §7, nothing chosen after the fact:
 *   - per anchor: per-domain MEDIAN over its runs, composite = production compositeOf of that vector;
 *   - ICC(A,1) AI composite vs target composite, F-based 95% CI (backend icc.js iccTwoRater — the
 *     estimator GET /oversight/icc uses), Spearman ρ (composite and per domain, approximate 95% CI);
 *   - mean bias (AI − target) per domain and for the composite;
 *   - FLAG every anchor with |AI composite − target| > the PRE-REGISTERED threshold, which is read
 *     from AUTHORING.md at run time, so the number in the spec and the number applied cannot diverge;
 *     the flag rate carries a Wilson 95% interval;
 *   - domain flags (|median − target| >= 2), diagnostic only;
 *   - test–retest: composite spread across runs, per anchor with >= 2 runs;
 *   - the §7.6 proceed rule: flagged anchors PLUS anchors with no valid score at all (every run failed
 *     production's contract or never returned) against the 20% allowance, with its verdict;
 *   - the model that SERVED each row (rows[].model), never just the one the run requested.
 *
 * EVIDENCE LEVEL: screening-synthetic (AI-authored, AI-scored) — not a decisive gate. Printed on
 * every report and written into the JSON, because a number that travels without its label gets
 * quoted as human agreement.
 *
 * Package-free (production composite + ICC load with no npm install).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf, iccTwoRater } from '../../probe/agreement-stats.mjs';
import { loadAnchorSplit, splitFilter } from './anchor-split.mjs';
import { PILOT_FREEZE } from './cues.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUTHORING_PATH = path.join(HERE, 'AUTHORING.md');
export const DESIGN_PATH = path.join(HERE, 'design.json');
export const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const EVIDENCE_LEVEL = 'screening-synthetic (AI-authored, AI-scored) — not a decisive gate';
export const DOMAIN_FLAG_DELTA = 2;
// AUTHORING.md §7.6: "no more than 4 of 20 anchors (20%)".
export const PROCEED_MAX_SHARE = 0.2;
export const PILOT_D5_CAVEAT = 'd5 is INFLATED BY RUBRIC ECHO on the pilot anchors: rubric-descriptor phrases '
  + 'correlate r = 0.64 with the d5 target (cues.mjs), so d5 can be recovered from wording without judging the appraisal.';

/** The pre-registered composite threshold, parsed from AUTHORING.md. Throws if the line is missing. */
export function parseThreshold(markdown) {
  const m = String(markdown).match(/PRE-REGISTERED THRESHOLD:\s*(\d+(?:\.\d+)?)\s*composite points/);
  if (!m) throw new Error('AUTHORING.md has no "PRE-REGISTERED THRESHOLD: <n> composite points" line');
  return Number(m[1]);
}

export async function loadThreshold(p = AUTHORING_PATH) {
  return parseThreshold(await readFile(p, 'utf8'));
}

const isScoreSet = (s) => s != null && typeof s === 'object' && DOMAINS.every((d) => Number.isFinite(s[d]));

/**
 * Normalise any accepted scores file into Map(id → [{d1..d7}, …]) plus provenance.
 * Rows without a full score set are counted, never silently dropped.
 */
export function normaliseScores(doc, { arm = 'local' } = {}) {
  const rows = Array.isArray(doc) ? doc : (Array.isArray(doc?.rows) ? doc.rows : null);
  if (!rows) throw new Error('scores file: expected an array or an object with a rows[] array');
  const runs = new Map();
  const served = new Map();          // id → model names that actually answered (rows[].model)
  const servedCounts = {};           // model → scored rows
  let unscored = 0;
  for (const r of rows) {
    const id = String(r?.id ?? '').toLowerCase();
    if (!id) { unscored++; continue; }
    const s = r.scores !== undefined ? r.scores : r[arm];
    if (!isScoreSet(s)) { unscored++; continue; }
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(Object.fromEntries(DOMAINS.map((d) => [d, s[d]])));
    const m = typeof r.model === 'string' && r.model ? r.model : null;
    if (m) {
      if (!served.has(id)) served.set(id, new Set());
      served.get(id).add(m);
      servedCounts[m] = (servedCounts[m] ?? 0) + 1;
    }
  }
  const provenance = Array.isArray(doc) ? {} : {
    // `requested_model` is what the run ASKED for (cfg.model); the served model per row is what answered.
    requested_model: doc.model ?? (arm === 'cloud' ? doc.cloudModel : doc.localModel) ?? null,
    served_models: servedCounts,
    revalidated: doc.revalidated ? { contract: doc.revalidated.contract, not_revalidatable: doc.revalidated.not_revalidatable } : null,
    prompt_version: doc.prompt_version_used ?? (arm === 'local' ? (doc.local_prompt_version ?? doc.prompt_version) : doc.prompt_version) ?? null,
    rubric_version: doc.rubric_version ?? null,
    probe: doc.probe ?? null,
  };
  return { runs, unscored, provenance, served };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Average ranks (ties share the mean rank). */
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return den ? num / den : null;
}

/**
 * Spearman ρ with an approximate 95% CI (Fisher z, Fieller–Hartley–Pearson SE = sqrt(1.06/(n−3))).
 * Null when n < 4 or either side has no variance — "no variance" is not "no agreement".
 */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return { rho: null, lower: null, upper: null, n };
  const rho = pearson(ranks(xs), ranks(ys));
  if (rho == null) return { rho: null, lower: null, upper: null, n, note: 'no variance' };
  if (n < 4 || Math.abs(rho) >= 1) return { rho, lower: null, upper: null, n };
  const z = Math.atanh(rho);
  const se = Math.sqrt(1.06 / (n - 3));
  return { rho, lower: Math.tanh(z - 1.96 * se), upper: Math.tanh(z + 1.96 * se), n };
}

/** Wilson score 95% interval for k of n. */
export function wilson(k, n) {
  if (!n) return { p: null, lower: null, upper: null };
  const z = 1.96, p = k / n;
  const den = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den;
  return { p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/**
 * The analysis. Pure: design + normalised runs in, report object out.
 * @param {object} design        design.json
 * @param {Map<string, object[]>} runs  id → score vectors
 * @param {{threshold: number, onlyIds?: string[], pilotOnly?: boolean, allowedIds?: Set<string>|null,
 *          served?: Map<string, Set<string>>}} opts   allowedIds = a split filter (anchor-split.mjs)
 */
export function knownGroups(design, runs, { threshold, onlyIds, pilotOnly = false, allowedIds = null, served = new Map(), fixtureShas = null } = {}) {
  if (!Number.isFinite(threshold)) throw new Error('knownGroups: a numeric pre-registered threshold is required');
  const wanted = onlyIds ? new Set(onlyIds.map((s) => s.toLowerCase())) : null;
  // §7.4-excluded anchors are out of the cohort: never designed-for here, never counted. A scores file
  // that still holds one (a run made before the exclusion) lists it under excluded_ids.
  const rows = design.anchors.filter((a) => !a.excluded && (!wanted || wanted.has(a.id)) && (!pilotOnly || a.pilot)
    && (!allowedIds || allowedIds.has(a.id)));
  const unknownIds = [...runs.keys()].filter((id) => !design.anchors.some((a) => a.id === id));
  const excludedIds = [...runs.keys()].filter((id) => design.anchors.some((a) => a.id === id && a.excluded)).sort();

  const anchors = [];
  for (const a of rows) {
    const vecs = runs.get(a.id) ?? [];
    if (!vecs.length) continue;
    const med = Object.fromEntries(DOMAINS.map((d) => [d, median(vecs.map((v) => v[d]))]));
    const aiComposite = compositeOf(med);
    const perRun = vecs.map((v) => compositeOf(v));
    const delta = r2(aiComposite - a.target_composite);
    const domainFlags = DOMAINS.filter((d) => Math.abs(med[d] - a.targets[d]) >= DOMAIN_FLAG_DELTA);
    anchors.push({
      id: a.id,
      language: a.language,
      profile: a.profile,
      runs: vecs.length,
      served_models: [...(served.get(a.id) ?? [])].sort(),
      target: a.targets,
      target_composite: a.target_composite,
      ai_median: med,
      ai_composite: aiComposite,
      delta,
      flagged: Math.abs(aiComposite - a.target_composite) > threshold,
      domain_flags: domainFlags,
      retest_range: perRun.length >= 2 ? r2(Math.max(...perRun) - Math.min(...perRun)) : null,
    });
  }

  const n = anchors.length;
  const comp = {
    n,
    icc: iccTwoRater(anchors.map((x) => ({ a: x.ai_composite, b: x.target_composite }))),
    spearman: spearman(anchors.map((x) => x.ai_composite), anchors.map((x) => x.target_composite)),
    bias: r2(mean(anchors.map((x) => x.ai_composite - x.target_composite))),
    mean_abs_delta: r2(mean(anchors.map((x) => Math.abs(x.ai_composite - x.target_composite)))),
  };
  const perDomain = Object.fromEntries(DOMAINS.map((d) => {
    const ai = anchors.map((x) => x.ai_median[d]);
    const tg = anchors.map((x) => x.target[d]);
    return [d, {
      spearman: spearman(ai, tg),
      icc: iccTwoRater(anchors.map((x) => ({ a: x.ai_median[d], b: x.target[d] }))),
      bias: r2(mean(ai.map((v, i) => v - tg[i]))),
      mean_abs_delta: r2(mean(ai.map((v, i) => Math.abs(v - tg[i])))),
      flagged: anchors.filter((x) => x.domain_flags.includes(d)).length,
    }];
  }));
  const flagged = anchors.filter((x) => x.flagged);
  // §7.6 counts an anchor with NO valid score as not expressing its target: an anchor the evaluator
  // cannot score is not one it reads correctly, and dropping it would flatter the rule (the
  // survivorship lesson of scripts/probe/model-agreement.mjs withRetry).
  const missingIds = rows.filter((a) => !anchors.some((x) => x.id === a.id)).map((a) => a.id);
  const notExpressing = flagged.length + missingIds.length;
  const allowed = Math.floor(PROCEED_MAX_SHARE * rows.length);
  const ranges = anchors.map((x) => x.retest_range).filter((v) => v != null);

  // Known authoring artefacts that inflate a domain's agreement, carried WITH the number so it cannot
  // travel without them (AUTHORING.md §3, pilot freeze).
  const caveats = {};
  // The echo (r = 0.64) was measured on the ORIGINAL pilot texts (PILOT_FREEZE.fixtures). The caveat
  // applies when the pilot anchors scored are those texts. A run that records which bytes it scored
  // (score-local's `fixtures` map) is checked against them; once any pilot anchor has been rewritten,
  // the echo is a property of a different set (validate.mjs gates it there) and the caveat is dropped.
  // A scores file that does not say which bytes it scored is treated as the originals.
  const originalPilot = (id) => !fixtureShas || fixtureShas[id] == null || fixtureShas[id] === PILOT_FREEZE.fixtures[id];
  const pilotScored = anchors.filter((x) => PILOT_FREEZE.fixtures[x.id] != null);
  // A §7.4 replacement (anc-101, …) is new text, so a run that scored one is not the original set either.
  const scoredReplacement = anchors.some((x) => rows.find((a) => a.id === x.id)?.replaces);
  if (pilotScored.length && !scoredReplacement && pilotScored.every((x) => originalPilot(x.id))) caveats.d5 = PILOT_D5_CAVEAT;
  return {
    evidence_level: EVIDENCE_LEVEL,
    caveats,
    threshold,
    domain_flag_delta: DOMAIN_FLAG_DELTA,
    n_designed: rows.length,
    n_scored: n,
    n_missing: rows.length - n,
    unknown_ids: unknownIds,
    excluded_ids: excludedIds,
    composite: comp,
    per_domain: perDomain,
    flags: { n: flagged.length, ids: flagged.map((x) => x.id), rate: wilson(flagged.length, n) },
    missing_ids: missingIds,
    proceed_rule: {
      rule: `AUTHORING.md §7.6: at most ${PROCEED_MAX_SHARE * 100}% of designed anchors may fail to express their target (flagged OR never validly scored)`,
      not_expressing: notExpressing,
      of: rows.length,
      allowed,
      rate: wilson(notExpressing, rows.length),
      verdict: rows.length ? (notExpressing <= allowed ? 'within' : 'exceeded') : 'n/a',
      note: '§7.6 applies AFTER the single rewrite round; on a first-pass run this verdict says whether a rewrite round is needed, not whether to scale.',
    },
    retest: ranges.length ? { n: ranges.length, median_range: median(ranges), max_range: Math.max(...ranges) } : null,
    anchors,
  };
}

/* ------------------------------------------------------------------ CLI */

function print(rep, prov) {
  const f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  const ci = (o) => (o?.lower == null ? '' : ` [${f(o.lower, 3)}, ${f(o.upper, 3)}]`);
  console.log(`\nknown-groups validity — anchor cohort`);
  console.log(`  EVIDENCE LEVEL: ${rep.evidence_level}`);
  const servedList = Object.entries(prov.served_models ?? {}).map(([m, k]) => `${m} ×${k}`).join(', ');
  console.log(`  served  ${servedList || '(no per-row model recorded)'}${prov.requested_model && servedList && !Object.keys(prov.served_models).every((m) => m === prov.requested_model) ? `  (requested ${prov.requested_model})` : ''}`);
  if (prov.revalidated) console.log(`  revalidated against ${prov.revalidated.contract}; ${prov.revalidated.not_revalidatable} row(s) could not be (no saved reply)`);
  console.log(`  prompt  ${prov.prompt_version ?? '(not recorded)'} · rubric ${prov.rubric_version ?? '(not recorded)'}`);
  console.log(`  n scored ${rep.n_scored} of ${rep.n_designed} designed  (missing ${rep.n_missing}${rep.unscored ? `, ${rep.unscored} unscored rows` : ''}${rep.unknown_ids.length ? `, ignored unknown ids ${rep.unknown_ids.join(',')}` : ''}${rep.excluded_ids?.length ? `, ignored §7.4-excluded ${rep.excluded_ids.join(',')}` : ''})`);
  console.log(`\n  composite (AI vs target, weighted 0-100)`);
  console.log(`    ICC(A,1) ${f(rep.composite.icc?.icc, 3)}${ci(rep.composite.icc)}  ${rep.composite.icc?.interpretation ?? ''}`);
  console.log(`    Spearman ρ ${f(rep.composite.spearman.rho, 3)}${ci(rep.composite.spearman)}   bias ${f(rep.composite.bias)}   mean |Δ| ${f(rep.composite.mean_abs_delta)}`);
  console.log(`\n    domain   Spearman ρ [95% CI]          ICC(A,1)   bias   mean|Δ|  flags(|Δ|>=${rep.domain_flag_delta})`);
  for (const d of DOMAINS) {
    const s = rep.per_domain[d];
    console.log(`    ${d}       ${f(s.spearman.rho, 3).padStart(6)}${ci(s.spearman).padEnd(22)} ${f(s.icc?.icc, 3).padStart(8)}  ${f(s.bias).padStart(5)}  ${f(s.mean_abs_delta).padStart(7)}  ${s.flagged}`);
    if (rep.caveats?.[d]) console.log(`             ⚠ ${rep.caveats[d]}`);
  }
  console.log(`\n  PRE-REGISTERED flag: |AI composite − target| > ${rep.threshold}  (AUTHORING.md §7)`);
  console.log(`    flagged ${rep.flags.n}/${rep.n_scored}  rate ${f(rep.flags.rate.p != null ? rep.flags.rate.p * 100 : null, 0)}% [${f(rep.flags.rate.lower != null ? rep.flags.rate.lower * 100 : null, 0)}–${f(rep.flags.rate.upper != null ? rep.flags.rate.upper * 100 : null, 0)}%]`);
  const pr = rep.proceed_rule;
  console.log(`\n  §7.6 proceed rule: not expressing = flagged ${rep.flags.n} + never validly scored ${rep.missing_ids.length} = ${pr.not_expressing} of ${pr.of}; allowed ${pr.allowed}  →  ${pr.verdict.toUpperCase()}`);
  if (rep.missing_ids.length) console.log(`    never validly scored: ${rep.missing_ids.join(', ')}`);
  console.log(`    ${pr.note}`);
  const multi = new Set(rep.anchors.flatMap((a) => a.served_models)).size > 1;
  console.log(`\n    id        lang  target  AI      Δ       runs  retest  flag  domain flags${multi ? '  served' : ''}`);
  for (const a of [...rep.anchors].sort((x, y) => x.target_composite - y.target_composite)) {
    console.log(`    ${a.id}   ${a.language.padEnd(4)}  ${String(a.target_composite).padStart(6)}  ${f(a.ai_composite, 1).padStart(5)}  ${(a.delta >= 0 ? '+' : '') + f(a.delta, 1)}`.padEnd(52)
      + `${String(a.runs).padStart(4)}  ${f(a.retest_range, 0).padStart(6)}  ${a.flagged ? 'FLAG' : '    '}  ${a.domain_flags.join(',')}`
      + (multi ? `  ${a.served_models.join(',')}` : ''));
  }
  if (rep.retest) console.log(`\n  test–retest composite range: median ${f(rep.retest.median_range, 1)}, max ${f(rep.retest.max_range, 1)} over ${rep.retest.n} anchors with >=2 runs`);
  console.log(`\n  ${rep.evidence_level}. Not human agreement; do not quote as such.\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > -1 ? argv[i + 1] : d; };
  const VALUE_FLAGS = new Set(['--arm', '--only', '--design', '--out', '--split']);
  const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
  if (!file) { console.error('usage: known-groups.mjs <scores.json> [--pilot] [--split tuning|heldout] [--arm local|cloud] [--only anc-001,…] [--design design.json] [--out report.json]'); process.exit(2); }
  const arm = arg('arm', 'local');
  if (!['local', 'cloud'].includes(arm)) { console.error('--arm must be local or cloud'); process.exit(2); }
  const design = JSON.parse(await readFile(path.resolve(arg('design', DESIGN_PATH)), 'utf8'));
  const doc = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const { runs, unscored, provenance, served } = normaliseScores(doc, { arm });
  const threshold = await loadThreshold();
  const only = arg('only') ? String(arg('only')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  let allowedIds;
  try { allowedIds = splitFilter(design, await loadAnchorSplit(), arg('split')); }
  catch (e) { console.error(`✖ ${e.message}`); process.exit(2); }
  const fixtureShas = doc && !Array.isArray(doc) && doc.fixtures && typeof doc.fixtures === 'object' ? doc.fixtures : null;
  const rep = { ...knownGroups(design, runs, { threshold, onlyIds: only, pilotOnly: argv.includes('--pilot'), allowedIds, served, fixtureShas }),
    unscored, source: path.basename(file), arm, split: arg('split'), provenance };
  print(rep, provenance);
  const out = arg('out');
  if (out) { await writeFile(path.resolve(out), JSON.stringify(rep, null, 2) + '\n'); console.log(`  report → ${out}\n`); }
}
