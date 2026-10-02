#!/usr/bin/env node
/*
 * The anchor cohort's DESIGN MATRIX: which PIS-7 score vector each synthetic transcript is written to
 * express. Deterministic from a seed, so the matrix is reproducible and its committed copy checkable.
 *
 * WHY A DESIGNED COHORT. The 26 real probe fixtures cluster in a narrow composite band (held-out
 * 32-62), and their between-episode SD is smaller than the evaluator's own noise (G0.5: 2.44 vs 4.66
 * needed). No ICC on that corpus can be decisive, for ANY scorer, because there is too little true
 * variance to agree about. A designed cohort fixes the variance by construction: targets are spread
 * across the whole scale, every domain visits every level, and d1/d2 — which had SD 0 in the human
 * data — are deliberately moved.
 *
 * WHAT IT GUARANTEES (checked by --check and by anchors.test.mjs):
 *   - weighted composite (rimpl/src/lib/composite.js compositeOf — production's, not a copy) spans
 *     ~15-95, stratified so each 10-point band holds roughly N/8 anchors;
 *   - every domain hits every level 0-5 at least twice (N=100);
 *   - d1 and d2 SD >= 1.0 across the cohort;
 *   - flat vectors (all seven domains equal) are a designed handful, never an accident;
 *   - ~30% of anchors are DISSOCIATED: one or two domains pulled far from the rest (strong reasoning
 *     with no reflection, weak questions with sharp appraisal) so a scorer that reads a global
 *     impression and stamps it on every domain is caught;
 *   - physician-turn count is assigned independently of the target, so length cannot encode level;
 *   - specialty mix across Thai Royal Colleges; ~20% English, the rest Thai with code-switching;
 *   - a stratified 20-anchor PILOT (anc-001..anc-020) that includes the lowest and highest composite;
 *   - §7.4 exclusions (REPLACEMENTS below) applied on top: the excluded row stays, marked `excluded`,
 *     and a new id (anc-101, …) copies its target vector and case slot. Coverage and every invariant
 *     are computed over the ACTIVE anchors (activeAnchors), so n stays 100.
 *
 * The ids are SHUFFLED with respect to the composite, so an id never hints at a level.
 * Targets live ONLY here — fixtures carry no score, so the scorer stays blind.
 *
 *   node scripts/calibration/anchors/design.mjs            # (re)write design.json
 *   node scripts/calibration/anchors/design.mjs --check    # regenerate in memory, compare, print coverage
 *   node scripts/calibration/anchors/design.mjs --n 100 --seed 20261002 --out /tmp/d.json
 *
 * Package-free: node built-ins plus rimpl's composite.js/versions.js, which are themselves
 * package-free. The calibration CI job runs on a bare checkout.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { compositeOf } = require('../../../rimpl/src/lib/composite.js');
const { RUBRIC_VERSION } = require('../../../rimpl/src/lib/versions.js');

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESIGN_PATH = path.join(HERE, 'design.json');
export const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const DEFAULT_N = 100;
export const DEFAULT_SEED = 20261002;
export const PILOT_N = 20;
export const DESIGN_VERSION = 1;

// Composite points one level of each domain is worth, derived from production's compositeOf rather
// than restated — if the weights move, the design moves with them (and --check goes red).
const ZERO = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
export const STEP = Object.fromEntries(DOMAINS.map((d) => [d, compositeOf({ ...ZERO, [d]: 1 }) - compositeOf(ZERO)]));

// Thai Royal Colleges (ราชวิทยาลัย) the cohort draws its cases from, with a few case framings each.
// Case framings are generic on purpose: an age, a sex, a presenting problem. Never a name, a place or
// a date — the transcripts are synthetic and must read as nobody in particular.
export const SPECIALTIES = [
  { key: 'im', en: 'Internal Medicine', th: 'อายุรศาสตร์', cases: [
    'type 2 diabetes with CKD stage 3 — choosing add-on therapy',
    'community-acquired pneumonia in an older adult — admit or treat at home',
    'new atrial fibrillation — anticoagulation decision',
    'hyponatraemia found on routine labs',
  ] },
  { key: 'peds', en: 'Pediatrics', th: 'กุมารเวชศาสตร์', cases: [
    'febrile infant under 3 months — workup threshold',
    'acute bronchiolitis — admission and therapy',
    'dengue in a school-age child — warning signs and fluids',
    'first afebrile seizure in a toddler',
  ] },
  { key: 'obgyn', en: 'Obstetrics & Gynaecology', th: 'สูติศาสตร์และนรีเวชวิทยา', cases: [
    'pre-eclampsia at 34 weeks — timing of delivery',
    'gestational diabetes — when to start insulin',
    'postpartum haemorrhage after vaginal delivery',
    'abnormal uterine bleeding in a perimenopausal woman',
  ] },
  { key: 'surg', en: 'Surgery', th: 'ศัลยศาสตร์', cases: [
    'right lower quadrant pain — appendicitis or not',
    'upper GI bleed in a patient on NSAIDs',
    'acute calculous cholecystitis — timing of cholecystectomy',
    'small-bowel obstruction in a patient with prior laparotomy',
  ] },
  { key: 'em', en: 'Emergency Medicine', th: 'เวชศาสตร์ฉุกเฉิน', cases: [
    'chest pain with a non-diagnostic first ECG',
    'suspected sepsis in an older adult — first-hour bundle',
    'syncope in a middle-aged adult — risk stratification',
    'minor head injury on anticoagulation — CT decision',
  ] },
  { key: 'fm', en: 'Family Medicine', th: 'เวชศาสตร์ครอบครัว', cases: [
    'newly found hypertension at a community clinic',
    'chronic low back pain with no red flags',
    'statin decision for primary prevention',
    'polypharmacy review in an older adult living alone',
  ] },
  { key: 'psych', en: 'Psychiatry', th: 'จิตเวชศาสตร์', cases: [
    'first-episode major depression — choosing an antidepressant',
    'suicidal ideation assessment in a primary-care visit',
    'alcohol withdrawal on a medical ward',
    'delirium vs dementia in a hospitalised older adult',
  ] },
  { key: 'ortho', en: 'Orthopaedics', th: 'ออร์โธปิดิกส์', cases: [
    'hip fracture in an older adult on antiplatelet therapy',
    'acute knee injury — when to image',
    'suspected septic arthritis of the knee',
    'osteoporosis treatment after a fragility fracture',
  ] },
  { key: 'neuro', en: 'Neurology', th: 'ประสาทวิทยา', cases: [
    'acute ischaemic stroke at 3 hours — thrombolysis decision',
    'new-onset headache with red flags',
  ] },
  { key: 'anes', en: 'Anaesthesiology', th: 'วิสัญญีวิทยา', cases: [
    'pre-operative assessment of a patient with stable angina',
    'perioperative management of anticoagulation',
  ] },
];

/* ------------------------------------------------------------------ seeded randomness */

// mulberry32, the same generator scripts/probe/reserve-split.mjs uses.
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  return { next, normal, shuffle, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const clamp = (v) => Math.max(0, Math.min(5, v));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1)); };
const isFlat = (t) => DOMAINS.every((d) => t[d] === t.d1);

/**
 * Integer vector closest to `desired` whose composite equals `target` (or as close as reachable).
 * Exhaustive over each domain's rounded value ±2: composite error dominates, then squared distance
 * from `desired`, weighted per domain so a deliberately dissociated domain is not pulled back toward
 * the rest. Exhaustive, not greedy, on purpose: a greedy ±1 search always grabs the domain worth the
 * most points (d2, 4 per level) first, and the cohort came out with d2 piled at 0 and 5.
 */
function fitToComposite(desired, target, { weight = {}, locked = new Set() } = {}) {
  const options = DOMAINS.map((d) => {
    const r = clamp(Math.round(desired[d]));
    if (locked.has(d)) return [r];
    const out = [];
    for (let v = Math.max(0, r - 2); v <= Math.min(5, r + 2); v++) out.push(v);
    return out;
  });
  let best = null;
  const cur = new Array(DOMAINS.length);
  const walk = (i, comp, dev) => {
    if (best && dev >= best.cost) return;               // deviation only grows; prune
    if (i === DOMAINS.length) {
      const cost = 10 * Math.abs(comp - target) + dev;
      if (!best || cost < best.cost - 1e-9) best = { cost, v: [...cur] };
      return;
    }
    const d = DOMAINS[i];
    for (const v of options[i]) {
      cur[i] = v;
      walk(i + 1, comp + STEP[d] * v, dev + (weight[d] ?? 1) * (v - desired[d]) ** 2);
    }
  };
  walk(0, 0, 0);
  return Object.fromEntries(DOMAINS.map((d, i) => [d, best.v[i]]));
}

// Pairs of domains worth the same composite points: moving one up and the other down keeps the
// composite fixed. Used to break an accidental flat vector without moving the target.
const SAME_STEP_PAIRS = DOMAINS.flatMap((a, i) => DOMAINS.slice(i + 1).filter((b) => STEP[a] === STEP[b]).map((b) => [a, b]));

/* ------------------------------------------------------------------ the generator */

/**
 * @param {{n?: number, seed?: number}} opts
 * @returns the design object written to design.json
 */
/*
 * §7.4 EXCLUSIONS AND REPLACEMENTS (AUTHORING.md §7.4 + amendment item 5). An anchor that was rewritten
 * once and is still beyond the line is EXCLUDED and REPLACED from the design: a new id at the SAME
 * target vector and case slot (every attribute copied), carrying the normal single-rewrite allowance.
 * The generator stays the seeded source of truth; this list is applied on top of it, so `--check` still
 * proves design.json is "seed + these recorded decisions" and nothing else. The excluded anchor keeps
 * its row (marked `excluded`) and its last fixture is archived under fixtures/excluded/, sha recorded
 * here, so history is never deleted. New ids continue after n (anc-101, anc-102, …) and are never reused.
 * Applied only to the committed seed/n — a different seed is a different cohort.
 */
export const REPLACEMENTS = [
  {
    excluded: 'anc-015',
    replaced_by: 'anc-101',
    date: '2026-10-02',
    reason: 'rewritten once (6827719) and still over-expressed by the round-2 blind panel (+22 > 15); §7.4: excluded and replaced',
    archived_fixture: 'fixtures/excluded/anc-015.json',
    sha256: '2eddee89302094bc95cf951ddded155dde16954029a9776061f34b1ea082088e',
  },
];

/** An anchor still in the cohort (not excluded under §7.4). */
export const isActive = (a) => !a.excluded;
export const activeAnchors = (design) => design.anchors.filter(isActive);

/** Apply §7.4 replacements to a generated design. Pure; throws on an inconsistent list. */
export function applyReplacements(design, replacements = REPLACEMENTS) {
  const anchors = design.anchors.map((a) => ({ ...a }));
  let next = design.n + 1;
  for (const r of replacements) {
    const old = anchors.find((a) => a.id === r.excluded);
    if (!old) throw new Error(`replacement: ${r.excluded} is not in the design`);
    if (old.excluded) throw new Error(`replacement: ${r.excluded} is already excluded`);
    const id = `anc-${String(next++).padStart(3, '0')}`;
    if (id !== r.replaced_by) throw new Error(`replacement: ${r.excluded} must be replaced by the next free id ${id}, not ${r.replaced_by}`);
    old.excluded = { date: r.date, reason: r.reason, replaced_by: id, archived_fixture: r.archived_fixture, sha256: r.sha256 };
    const { excluded: _e, ...attrs } = old;
    anchors.push({ ...attrs, id, replaces: r.excluded });
  }
  return { ...design, anchors };
}

export function generateDesign({ n = DEFAULT_N, seed = DEFAULT_SEED, replacements } = {}) {
  const base = generateBaseDesign({ n, seed });
  return applyReplacements(base, replacements ?? (n === DEFAULT_N && seed === DEFAULT_SEED ? REPLACEMENTS : []));
}

function generateBaseDesign({ n, seed }) {
  if (!Number.isInteger(n) || n < PILOT_N) throw new Error(`n must be an integer >= ${PILOT_N}`);
  const R = rng(seed);
  const LO = 15, HI = 95;

  // 1. Stratified composite targets: one per stratum of (HI-LO)/n, jittered within it.
  const strata = Array.from({ length: n }, (_, i) => LO + (HI - LO) * (i + R.next()) / n);

  // 2. A designed handful of flat vectors at the strata closest to 20/40/60/80.
  const flatAt = new Map();
  const nFlat = Math.max(2, Math.round(n * 0.04));
  const flatLevels = [1, 2, 3, 4].slice(0, nFlat);
  for (const lvl of flatLevels) {
    let bestI = -1;
    for (let i = 0; i < n; i++) {
      if (flatAt.has(i)) continue;
      if (bestI < 0 || Math.abs(strata[i] - lvl * 20) < Math.abs(strata[bestI] - lvl * 20)) bestI = i;
    }
    flatAt.set(bestI, lvl);
  }

  // 3. Profiles. ~30% dissociated, chosen by a seeded shuffle so they are spread across the range.
  const nonFlat = [...Array(n).keys()].filter((i) => !flatAt.has(i));
  const dissociated = new Set(R.shuffle(nonFlat).slice(0, Math.round(n * 0.3)));

  const rows = strata.map((t, i) => {
    if (flatAt.has(i)) {
      const lvl = flatAt.get(i);
      return { profile: 'flat', targets: Object.fromEntries(DOMAINS.map((d) => [d, lvl])), dissociated_domains: [] };
    }
    const base = t / 20;
    const desired = Object.fromEntries(DOMAINS.map((d) => [d, base + 0.75 * R.normal()]));
    const weight = {};
    const pulled = [];
    if (dissociated.has(i)) {
      // Pull one (sometimes two) domains 2.5-3.5 levels away from the rest, in whichever direction
      // has room. That domain is weighted heavily so the composite fit compensates elsewhere.
      const k = R.next() < 0.3 ? 2 : 1;
      for (const d of R.shuffle(DOMAINS).slice(0, k)) {
        const gap = 2.5 + R.next();
        const dir = base + gap <= 5.2 && (base - gap < -0.2 || R.next() < 0.5) ? 1 : -1;
        desired[d] = clamp(base + dir * gap);
        weight[d] = 6;
        pulled.push(d);
      }
    }
    let targets = fitToComposite(desired, Math.round(t), { weight });
    if (isFlat(targets)) {
      const [a, b] = SAME_STEP_PAIRS.find(([x, y]) => targets[x] < 5 && targets[y] > 0) ?? SAME_STEP_PAIRS[0];
      targets = { ...targets, [a]: targets[a] + 1, [b]: targets[b] - 1 };
    }
    return { profile: pulled.length ? 'dissociated' : 'graded', targets, dissociated_domains: pulled.sort() };
  });

  // 4. Coverage repair: every domain must visit every level at least `minPerLevel` times. Take the
  //    non-flat anchor whose value in that domain is nearest the missing level, lock the domain at
  //    the level, and refit the others to the same composite.
  const minPerLevel = n >= 60 ? 2 : 1;
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const d of DOMAINS) {
      for (let lvl = 0; lvl <= 5; lvl++) {
        const count = rows.filter((r) => r.targets[d] === lvl).length;
        if (count >= minPerLevel) continue;
        // Candidates: non-flat, and not the only holder of their current level in this domain.
        const cands = rows
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r.profile !== 'flat' && rows.filter((o) => o.targets[d] === r.targets[d]).length > minPerLevel)
          .sort((a, b) => (Math.abs(a.r.targets[d] - lvl) - Math.abs(b.r.targets[d] - lvl)) || (a.i - b.i));
        for (const { r } of cands) {
          const comp = compositeOf(r.targets);
          const desired = { ...r.targets, [d]: lvl };
          const refit = fitToComposite(desired, comp, { locked: new Set([d]) });
          if (compositeOf(refit) === comp && !isFlat(refit)) { r.targets = refit; changed = true; break; }
        }
      }
    }
    if (!changed) break;
  }

  // 5. Attributes that must NOT track the target: shuffled independently of it.
  const specialtySlots = R.shuffle(Array.from({ length: n }, (_, i) => SPECIALTIES[i % SPECIALTIES.length].key));
  const turnSlots = R.shuffle(Array.from({ length: n }, (_, i) => 4 + (i % 5)));      // 4..8 physician turns
  const modeSlots = R.shuffle(Array.from({ length: n }, (_, i) => (i % 2 ? 'examiner' : 'natural')));
  const caseCursor = Object.fromEntries(SPECIALTIES.map((s) => [s.key, 0]));

  const anchors = rows.map((r, i) => {
    const spec = SPECIALTIES.find((s) => s.key === specialtySlots[i]);
    const caseText = spec.cases[caseCursor[spec.key]++ % spec.cases.length];
    const d6 = r.targets.d6;
    return {
      ...r,
      target_composite: compositeOf(r.targets),
      specialty: { key: spec.key, en: spec.en, th: spec.th },
      case: caseText,
      tutor_mode: modeSlots[i],
      physician_turns: turnSlots[i],
      // d6 = 0 means "no reflection" (the CREC anchor), so nothing reflective may appear at all.
      reflection: d6 === 0 ? 'none' : (R.next() < 0.75 ? 'reflection_turn' : 'in_chat'),
    };
  });

  // 6. Pilot: 20 anchors at evenly spaced ranks of the composite, forced to include both extremes.
  const byComposite = anchors.map((a, i) => ({ a, i })).sort((x, y) => (x.a.target_composite - y.a.target_composite) || (x.i - y.i));
  const pilotRanks = new Set(Array.from({ length: PILOT_N }, (_, k) => Math.round((k + 0.5) * n / PILOT_N)));
  pilotRanks.delete(Math.round(0.5 * n / PILOT_N)); pilotRanks.add(0);
  pilotRanks.delete(Math.round((PILOT_N - 0.5) * n / PILOT_N)); pilotRanks.add(n - 1);
  byComposite.forEach(({ a }, rank) => { a.pilot = pilotRanks.has(rank); });

  // 7. Language: every 5th anchor by composite rank is English, separately within the pilot and the
  //    rest, so English is spread across the whole range rather than bunched at one end.
  for (const group of [byComposite.filter(({ a }) => a.pilot), byComposite.filter(({ a }) => !a.pilot)]) {
    group.forEach(({ a }, k) => { a.language = k % 5 === 2 ? 'en' : 'th'; });
  }

  // 8. Ids: pilot gets anc-001..anc-020, the rest anc-021.., each block in SHUFFLED order so an id
  //    carries no information about its level.
  const pilot = R.shuffle(anchors.filter((a) => a.pilot));
  const rest = R.shuffle(anchors.filter((a) => !a.pilot));
  const ordered = [...pilot, ...rest].map((a, k) => ({
    id: `anc-${String(k + 1).padStart(3, '0')}`,
    pilot: a.pilot,
    language: a.language,
    specialty: a.specialty,
    case: a.case,
    tutor_mode: a.tutor_mode,
    physician_turns: a.physician_turns,
    reflection: a.reflection,
    profile: a.profile,
    dissociated_domains: a.dissociated_domains,
    targets: a.targets,
    target_composite: a.target_composite,
  }));

  return {
    design_version: DESIGN_VERSION,
    seed,
    n,
    composite: 'rimpl/src/lib/composite.js compositeOf (weighted, x20, 0-100)',
    rubric_version: RUBRIC_VERSION,
    note: 'Targets are the DESIGNED scores each synthetic transcript is written to express. Never copy them into a fixture: the scorer must be blind.',
    anchors: ordered,
  };
}

/* ------------------------------------------------------------------ coverage + invariants */

export function coverage(design) {
  const A = activeAnchors(design);
  const comps = A.map((a) => a.target_composite);
  const bands = [];
  for (let lo = 15; lo < 95; lo += 10) bands.push({ lo, hi: lo + 10, n: comps.filter((c) => c >= lo && c < lo + 10).length });
  const levels = Object.fromEntries(DOMAINS.map((d) => [d, [0, 1, 2, 3, 4, 5].map((l) => A.filter((a) => a.targets[d] === l).length)]));
  const domainSd = Object.fromEntries(DOMAINS.map((d) => [d, sd(A.map((a) => a.targets[d]))]));
  const count = (f) => A.reduce((m, a) => { const k = f(a); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const turns = A.map((a) => a.physician_turns);
  const corr = (xs, ys) => {
    const mx = mean(xs), my = mean(ys);
    const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    return num / Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  };
  const pilot = A.filter((a) => a.pilot);
  return {
    n: A.length,
    composite: { min: Math.min(...comps), max: Math.max(...comps), mean: mean(comps), sd: sd(comps), bands },
    levels,
    domainSd,
    flat: A.filter((a) => DOMAINS.every((d) => a.targets[d] === a.targets.d1)).length,
    profiles: count((a) => a.profile),
    languages: count((a) => a.language),
    specialties: count((a) => a.specialty.key),
    tutorModes: count((a) => a.tutor_mode),
    reflection: count((a) => a.reflection),
    turnsVsComposite: corr(turns, comps),
    pilot: {
      n: pilot.length,
      ids: pilot.map((a) => a.id),
      composites: pilot.map((a) => a.target_composite).sort((x, y) => x - y),
      english: pilot.filter((a) => a.language === 'en').length,
      includesMin: pilot.some((a) => a.target_composite === Math.min(...comps)),
      includesMax: pilot.some((a) => a.target_composite === Math.max(...comps)),
    },
  };
}

/** Returns a list of human-readable invariant failures; empty = the design is acceptable. */
export function checkInvariants(design) {
  const errs = [];
  const A = activeAnchors(design);
  const cov = coverage(design);
  const ALL = design.anchors;
  if (new Set(ALL.map((a) => a.id)).size !== ALL.length) errs.push('duplicate ids (including excluded anchors)');
  const SAME = ['pilot', 'language', 'specialty', 'case', 'tutor_mode', 'physician_turns', 'reflection', 'profile', 'dissociated_domains', 'targets', 'target_composite'];
  for (const old of ALL.filter((a) => a.excluded)) {
    const repl = ALL.filter((a) => a.replaces === old.id);
    if (repl.length !== 1 || repl[0].id !== old.excluded.replaced_by) { errs.push(`${old.id} is excluded but not replaced exactly once by ${old.excluded.replaced_by}`); continue; }
    for (const k of SAME) if (JSON.stringify(repl[0][k]) !== JSON.stringify(old[k])) errs.push(`${repl[0].id} must copy ${k} from ${old.id} (same target vector and case slot)`);
  }
  for (const a of ALL.filter((x) => x.replaces)) if (!ALL.some((o) => o.id === a.replaces && o.excluded)) errs.push(`${a.id} replaces ${a.replaces}, which is not excluded`);
  for (const a of A) {
    for (const d of DOMAINS) {
      if (!Number.isInteger(a.targets[d]) || a.targets[d] < 0 || a.targets[d] > 5) errs.push(`${a.id} ${d}=${a.targets[d]} is not an integer 0-5`);
    }
    if (compositeOf(a.targets) !== a.target_composite) errs.push(`${a.id} target_composite ${a.target_composite} != compositeOf(targets) ${compositeOf(a.targets)}`);
    if (a.targets.d6 === 0 && a.reflection !== 'none') errs.push(`${a.id} d6=0 but reflection=${a.reflection}`);
  }
  if (new Set(A.map((a) => a.id)).size !== A.length) errs.push('duplicate ids');
  if (cov.composite.min > 20) errs.push(`lowest composite ${cov.composite.min} > 20`);
  if (cov.composite.max < 90) errs.push(`highest composite ${cov.composite.max} < 90`);
  const perBand = A.length / cov.composite.bands.length;
  for (const b of cov.composite.bands) if (b.n < 0.5 * perBand) errs.push(`composite band ${b.lo}-${b.hi} has ${b.n} anchors (< half of ${perBand.toFixed(1)})`);
  const minPerLevel = A.length >= 60 ? 2 : 1;
  for (const d of DOMAINS) {
    cov.levels[d].forEach((c, lvl) => { if (c < minPerLevel) errs.push(`${d} level ${lvl} appears ${c}x (< ${minPerLevel})`); });
  }
  for (const d of ['d1', 'd2']) if (cov.domainSd[d] < 1.0) errs.push(`${d} SD ${cov.domainSd[d].toFixed(2)} < 1.0`);
  if (cov.flat > Math.max(4, Math.round(A.length * 0.05))) errs.push(`${cov.flat} flat vectors — more than a designed handful`);
  const en = (cov.languages.en ?? 0) / A.length;
  if (en < 0.15 || en > 0.25) errs.push(`English share ${(en * 100).toFixed(0)}% outside 15-25%`);
  if (Object.keys(cov.specialties).length < 8) errs.push(`only ${Object.keys(cov.specialties).length} specialties`);
  if (Math.abs(cov.turnsVsComposite) >= 0.3) errs.push(`physician-turn count correlates with composite (r=${cov.turnsVsComposite.toFixed(2)})`);
  if (cov.pilot.n !== PILOT_N) errs.push(`pilot has ${cov.pilot.n} anchors, not ${PILOT_N}`);
  if (!cov.pilot.includesMin || !cov.pilot.includesMax) errs.push('pilot does not include both the lowest and the highest composite');
  if (cov.pilot.english < 3) errs.push(`pilot has ${cov.pilot.english} English anchors (< 3)`);
  // The pilot is anc-001..anc-020 as generated, with each §7.4-excluded one swapped for its replacement.
  const pilotIds = A.filter((a) => a.pilot).map((a) => a.id).sort();
  const swap = new Map(ALL.filter((a) => a.excluded).map((a) => [a.id, a.excluded.replaced_by]));
  const expected = Array.from({ length: PILOT_N }, (_, k) => `anc-${String(k + 1).padStart(3, '0')}`).map((id) => swap.get(id) ?? id).sort();
  if (JSON.stringify(pilotIds) !== JSON.stringify(expected)) errs.push('pilot ids are not anc-001..anc-020 (with §7.4 replacements swapped in)');
  return errs;
}

export const serialise = (design) => JSON.stringify(design, null, 2) + '\n';

export async function loadDesign(p = DESIGN_PATH) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/* ------------------------------------------------------------------ CLI */

function printCoverage(cov) {
  const pad = (s, w) => String(s).padStart(w);
  console.log(`\nanchor design — n=${cov.n}`);
  console.log(`  composite  min ${cov.composite.min}  max ${cov.composite.max}  mean ${cov.composite.mean.toFixed(1)}  sd ${cov.composite.sd.toFixed(1)}`);
  console.log(`  bands      ${cov.composite.bands.map((b) => `${b.lo}-${b.hi}:${b.n}`).join('  ')}`);
  console.log('  levels     domain   0   1   2   3   4   5    SD');
  for (const d of DOMAINS) console.log(`             ${d.padEnd(6)}${cov.levels[d].map((c) => pad(c, 4)).join('')}  ${cov.domainSd[d].toFixed(2)}`);
  console.log(`  profiles   ${JSON.stringify(cov.profiles)}   flat vectors ${cov.flat}`);
  console.log(`  language   ${JSON.stringify(cov.languages)}   tutor ${JSON.stringify(cov.tutorModes)}`);
  console.log(`  reflection ${JSON.stringify(cov.reflection)}`);
  console.log(`  specialty  ${JSON.stringify(cov.specialties)}`);
  console.log(`  turns×composite r = ${cov.turnsVsComposite.toFixed(3)}  (must stay near 0: length must not encode level)`);
  console.log(`  pilot      n=${cov.pilot.n}  english ${cov.pilot.english}  composites ${cov.pilot.composites.join(' ')}`);
  for (const r of REPLACEMENTS) console.log(`  excluded   ${r.excluded} → replaced by ${r.replaced_by} (${r.date}; archived ${r.archived_fixture})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i > -1 ? argv[i + 1] : d; };
  const n = Number(arg('n', DEFAULT_N));
  const seed = Number(arg('seed', DEFAULT_SEED));
  const out = path.resolve(arg('out', DESIGN_PATH));
  const design = generateDesign({ n, seed });
  const errs = checkInvariants(design);
  if (argv.includes('--check')) {
    let committed = null;
    try { committed = await readFile(out, 'utf8'); } catch { /* missing is a failure below */ }
    printCoverage(coverage(design));
    if (committed !== serialise(design)) errs.push(`${path.relative(process.cwd(), out)} differs from what seed ${seed} / n ${n} generates — regenerate it, or find what changed (weights? generator?)`);
    if (errs.length) { console.error(`\n✖ ${errs.length} problem(s):\n  - ${errs.join('\n  - ')}`); process.exit(1); }
    console.log('\n✔ design.json matches the generator and every invariant holds');
  } else {
    if (errs.length) { console.error(`✖ refusing to write — invariants fail:\n  - ${errs.join('\n  - ')}`); process.exit(1); }
    await writeFile(out, serialise(design));
    printCoverage(coverage(design));
    console.log(`\nwrote ${out}`);
  }
}
