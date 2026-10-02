#!/usr/bin/env node
/*
 * The authoring BATCH PLAN for the 80 non-pilot anchors: which rows go in which batch, and the
 * SURFACE SHAPE ("cue budget") each anchor is written in. Deterministic from a seed.
 *
 *   node scripts/calibration/anchors/batch-plan.mjs           # (re)write batches.json + BATCH-PLAN.md
 *   node scripts/calibration/anchors/batch-plan.mjs --check   # regenerate in memory and compare; simulate the cue gate
 *
 * BATCHES. The 80 rows, sorted by target composite, are cut into strata of 8 consecutive rows; each
 * stratum puts one row in each of the 8 batches (seeded), so every batch of 10 spans the whole range.
 * Then English rows are swapped within a stratum until every batch has 2 (16 English / 8 batches).
 *
 * CUE BUDGETS. The pilot showed authors write more, cite more numbers and drop the casual "ok" as the
 * target rises (AUTHORING.md §3). Asking authors to "vary" does not undo that. So each row is ASSIGNED a
 * surface shape before it is written, independently of its target: within every run of k consecutive
 * rows by composite (k = number of levels), each level of each feature is used once, in seeded order.
 * By construction no budget tracks the composite. The author writes the target level INSIDE that
 * shape. `--check` simulates the cohort cue gate (cues.mjs, all 100 anchors, pilot as written) with
 * authors landing anywhere inside their budgets, and reports how often it would fail.
 *
 * EXTRA REVIEW. Rows with d4 <= 1 and d5 >= 4 — the combination the pilot could not write first time
 * (anc-015 excluded, anc-101 needed its rewrite) — are flagged `extra_review`, placed LAST in their
 * batch, and get a coordinator read before intake. The flag is a design property, the same for every
 * split, so it reveals nothing about which split a row is in.
 *
 * The plan never says which split (tuning / held-out) an anchor is in: authors must not know.
 *
 *   --drift N   also simulate authors who add N physician characters per composite point
 *               (the pilot's habit was about 5; at 5 the gate fails almost always — see AUTHORING §9)
 *
 * Package-free.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng, DOMAINS, loadDesign, activeAnchors } from './design.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BATCHES_PATH = path.join(HERE, 'batches.json');
export const PLAN_MD_PATH = path.join(HERE, 'BATCH-PLAN.md');
export const BATCH_SEED = 20261006;
export const N_BATCHES = 8;

// Surface shapes. Ranges are what validate.mjs measures (cues.mjs cueFeatures).
export const BUDGET_LEVELS = {
  length: ['short', 'medium', 'long'],         // total physician characters
  ack_turns: [0, 1, 2],                        // physician turns carrying ONE casual acknowledgement
  numerals: ['few', 'some', 'many'],           // numerals per physician turn
  list_lines: [0, 0, 'some'],                  // bullet / numbered lines in physician turns + reflection
};
export const BUDGET_RANGES = {
  length: { short: [900, 1250], medium: [1250, 1650], long: [1650, 2100] },
  numerals: { few: [0, 1], some: [2, 3.5], many: [4, 7] },
  list_lines: { 0: [0, 0], some: [2, 4] },
};
export const BUDGET_TEXT = {
  length: { short: 'SHORT — 900–1250 physician characters in total', medium: 'MEDIUM — 1250–1650 physician characters', long: 'LONG — 1650–2100 physician characters' },
  ack_turns: { 0: 'NO acknowledgement tokens (ok / โอเค / noted / รับทราบ / เข้าใจแล้ว)', 1: 'exactly ONE physician turn carries one casual acknowledgement (e.g. "ok ครับ", "noted")', 2: 'exactly TWO physician turns each carry one casual acknowledgement' },
  numerals: { few: 'FEW numerals — about 0–1 per physician turn', some: 'SOME numerals — about 2–3 per physician turn', many: 'MANY numerals — 4 or more per physician turn (labs, vitals, doses, durations in days)' },
  list_lines: { 0: 'NO bullet or numbered lines in physician turns or the reflection', some: '2–4 bullet or numbered lines in physician turns (a structured question or a listed plan)' },
  rubric_echo: 'ZERO rubric-descriptor words in physician turns and the reflection (see AUTHOR-BRIEF §5)',
};

export const EXTRA_REVIEW = 'd4 <= 1 with d5 >= 4: the hardest combination to write (pilot: anc-015 excluded, anc-101 needed its rewrite). Written last in the batch; the coordinator reads it before intake.';
export const needsExtraReview = (r) => r.targets.d4 <= 1 && r.targets.d5 >= 4;

const nonPilot = (design) => activeAnchors(design).filter((a) => !a.pilot)
  .sort((x, y) => (x.target_composite - y.target_composite) || x.id.localeCompare(y.id));

/** Balanced, seeded assignment of one feature's levels along the composite order. */
function assignLevels(rows, levels, R) {
  const out = {};
  for (let i = 0; i < rows.length; i += levels.length) {
    const perm = R.shuffle([...levels]);
    rows.slice(i, i + levels.length).forEach((r, k) => { out[r.id] = perm[k]; });
  }
  return out;
}

export function planBatches(design, { seed = BATCH_SEED } = {}) {
  const R = rng(seed);
  const rows = nonPilot(design);
  if (rows.length % N_BATCHES) throw new Error(`${rows.length} rows do not divide into ${N_BATCHES} batches`);
  const batchOf = {};
  const strata = [];
  for (let i = 0; i < rows.length; i += N_BATCHES) {
    const stratum = rows.slice(i, i + N_BATCHES);
    const perm = R.shuffle([...Array(N_BATCHES).keys()]);
    stratum.forEach((r, k) => { batchOf[r.id] = perm[k]; });
    strata.push(stratum);
  }
  // Language repair: swap an English row out of a batch with too many, within one stratum.
  const want = rows.filter((r) => r.language === 'en').length / N_BATCHES;
  const enIn = (b) => rows.filter((r) => batchOf[r.id] === b && r.language === 'en').length;
  for (let guard = 0; guard < 200; guard++) {
    const over = [...Array(N_BATCHES).keys()].find((b) => enIn(b) > Math.ceil(want));
    const under = [...Array(N_BATCHES).keys()].find((b) => enIn(b) < Math.floor(want));
    if (over == null || under == null) break;
    const st = strata.find((s) => s.some((r) => batchOf[r.id] === over && r.language === 'en') && s.some((r) => batchOf[r.id] === under && r.language === 'th'));
    if (!st) break;
    const a = st.find((r) => batchOf[r.id] === over && r.language === 'en');
    const b = st.find((r) => batchOf[r.id] === under && r.language === 'th');
    [batchOf[a.id], batchOf[b.id]] = [batchOf[b.id], batchOf[a.id]];
  }
  const budgets = Object.fromEntries(rows.map((r) => [r.id, {}]));
  for (const [f, levels] of Object.entries(BUDGET_LEVELS)) {
    const got = assignLevels(rows, levels, R);
    for (const r of rows) budgets[r.id][f] = got[r.id];
  }
  for (const r of rows) budgets[r.id].rubric_echo = 0;
  const batches = [...Array(N_BATCHES).keys()].map((b) => ({
    batch: b + 1,
    rows: rows.filter((r) => batchOf[r.id] === b)
      .sort((x, y) => (needsExtraReview(x) - needsExtraReview(y)) || x.id.localeCompare(y.id)).map((r) => ({
      id: r.id,
      language: r.language,
      specialty: r.specialty,
      case: r.case,
      tutor_mode: r.tutor_mode,
      physician_turns: r.physician_turns,
      reflection: r.reflection,
      profile: r.profile,
      dissociated_domains: r.dissociated_domains,
      targets: r.targets,
      target_composite: r.target_composite,
      cue_budget: budgets[r.id],
      ...(needsExtraReview(r) ? { extra_review: EXTRA_REVIEW } : {}),
    })),
  }));
  return {
    seed,
    note: 'Authoring batches for the 80 non-pilot anchors. Each row: the design attributes the author must hit, plus an assigned surface shape (cue_budget) chosen independently of the target. Split membership is deliberately absent. Regenerate with batch-plan.mjs.',
    batches,
  };
}

export function budgetProse(b) {
  return [BUDGET_TEXT.length[b.length], BUDGET_TEXT.ack_turns[b.ack_turns], BUDGET_TEXT.numerals[b.numerals],
    BUDGET_TEXT.list_lines[b.list_lines], BUDGET_TEXT.rubric_echo];
}

export function planMarkdown(plan) {
  const L = ['# Anchor authoring — batch plan', '',
    '> Generated by `batch-plan.mjs` — do not edit by hand. Each author gets ONE row and `AUTHOR-BRIEF.md`.',
    '> Split membership is deliberately not shown.', ''];
  const t = (o) => DOMAINS.map((d) => o[d]).join(',');
  for (const b of plan.batches) {
    const en = b.rows.filter((r) => r.language === 'en').length;
    const comps = b.rows.map((r) => r.target_composite);
    L.push(`## Batch ${b.batch} — ${b.rows.length} anchors · composites ${Math.min(...comps)}–${Math.max(...comps)} · English ${en} · examiner ${b.rows.filter((r) => r.tutor_mode === 'examiner').length}`, '');
    L.push('| id | lang | specialty | case | tutor | phys turns | reflection | profile | targets d1–d7 | comp | length | acks | numerals | lists |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of b.rows) {
      const c = r.cue_budget;
      const prof = r.profile === 'dissociated' ? `dissociated (${r.dissociated_domains.join(',')})` : r.profile;
      L.push(`| ${r.id}${r.extra_review ? ' ⚠' : ''} | ${r.language} | ${r.specialty.en} | ${r.case} | ${r.tutor_mode} | ${r.physician_turns} | ${r.reflection} | ${prof} | ${t(r.targets)} | ${r.target_composite} | ${c.length} | ${c.ack_turns} | ${c.numerals} | ${c.list_lines} |`);
    }
    L.push('');
  }
  L.push(`⚠ = extra review: ${EXTRA_REVIEW}`, '');
  return L.join('\n');
}

export const serialisePlan = (plan) => JSON.stringify(plan, null, 2) + '\n';

/**
 * Simulate the cohort cue gate: the existing fixtures' measured features (the pilot, as written) plus
 * every planned row landing uniformly at random INSIDE its budget. Returns the failure rate and the
 * pairs that failed. This is what the budgets buy, assuming authors stay inside them.
 */
export function simulateCueGate(plan, existing, { sims = 400, seed = 7, cueCheck, lengthDrift = 0 }) {
  const R = rng(seed);
  const u = ([lo, hi]) => lo + (hi - lo) * R.next();
  const rows = plan.batches.flatMap((b) => b.rows);
  let fails = 0;
  const pairs = {};
  for (let s = 0; s < sims; s++) {
    const entries = [...existing];
    for (const r of rows) {
      const b = r.cue_budget;
      const turns = r.physician_turns;
      entries.push({ id: r.id, row: r, features: {
        length: u(BUDGET_RANGES.length[b.length]) + lengthDrift * (r.target_composite - 55),
        acks: b.ack_turns / turns,
        numbers: u(BUDGET_RANGES.numerals[b.numerals]),
        list_lines: Math.round(u(BUDGET_RANGES.list_lines[b.list_lines])),
        rubric_echo: 0,
      } });
    }
    const res = cueCheck(entries);
    if (res.failures.length) fails++;
    for (const f of res.failures) pairs[`${f.feature}:${f.target}`] = (pairs[`${f.feature}:${f.target}`] ?? 0) + 1;
  }
  return { sims, fail_rate: fails / sims, pairs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const design = await loadDesign();
  const plan = planBatches(design);
  const json = serialisePlan(plan), md = planMarkdown(plan) + '\n';
  const { validateAll } = await import('./validate.mjs');
  const { cueCheck } = await import('./cues.mjs');
  const { results } = await validateAll();
  const existing = results.filter((r) => r.features && r.row && !r.row.excluded).map((r) => ({ id: r.id, row: r.row, features: r.features }));
  const sim = simulateCueGate(plan, existing, { cueCheck });
  console.log(`batch plan — ${plan.batches.length} batches, seed ${plan.seed}`);
  for (const b of plan.batches) {
    const comps = b.rows.map((r) => r.target_composite);
    console.log(`  batch ${b.batch}: ${b.rows.length} rows, composites ${Math.min(...comps)}–${Math.max(...comps)}, en ${b.rows.filter((r) => r.language === 'en').length}, examiner ${b.rows.filter((r) => r.tutor_mode === 'examiner').length}`);
  }
  console.log(`  cue gate, simulated over ${existing.length} existing + ${plan.batches.flatMap((b) => b.rows).length} planned anchors landing inside their budgets: fails ${(sim.fail_rate * 100).toFixed(1)}% of ${sim.sims} draws ${Object.keys(sim.pairs).length ? JSON.stringify(sim.pairs) : ''}`);
  const di = process.argv.indexOf('--drift');
  if (di > -1) {
    const drift = Number(process.argv[di + 1]);
    const d = simulateCueGate(plan, existing, { cueCheck, lengthDrift: drift });
    console.log(`  … with authors drifting +${drift} physician characters per composite point: fails ${(d.fail_rate * 100).toFixed(1)}% ${JSON.stringify(d.pairs)}`);
  }
  if (process.argv.includes('--check')) {
    let bad = 0;
    for (const [p, want] of [[BATCHES_PATH, json], [PLAN_MD_PATH, md]]) {
      let have = null; try { have = await readFile(p, 'utf8'); } catch { /* missing */ }
      if (have !== want) { console.error(`✖ ${path.basename(p)} differs from what seed ${plan.seed} generates — regenerate it`); bad++; }
    }
    if (bad) process.exit(1);
    console.log('✔ batches.json and BATCH-PLAN.md match the generator');
  } else {
    await writeFile(BATCHES_PATH, json);
    await writeFile(PLAN_MD_PATH, md);
    console.log(`wrote ${path.relative(process.cwd(), BATCHES_PATH)} and ${path.relative(process.cwd(), PLAN_MD_PATH)}`);
  }
}
