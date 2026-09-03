// Stratified audit sampling — choosing WHICH evaluated PLEs go to human review.
//
// The manuscript describes stratified random sampling by score band. What existed was manual
// assignment one PLE at a time, which produces a convenience sample: whoever an admin happened to
// click. That matters because the ICC is estimated on the audited subset, and a subset drawn from
// the middle of the score distribution understates disagreement at the extremes — precisely where a
// credit decision is most contested.
//
// THREE PROPERTIES THIS MODULE EXISTS TO GUARANTEE:
//
//   1. REPRODUCIBLE. The draw is seeded, never Math.random(). A reviewer asking "how were these 40
//      chosen" gets an answer that can be re-run and checked, and a re-run with the same seed and
//      the same pool returns the same PLEs. This is the same reasoning as the Socratic allocation in
//      routes/ples.js — an unreproducible randomisation is indistinguishable from a hand-picked one.
//   2. PROPORTIONAL AND EXACT. Band quotas use largest-remainder, so the parts sum to the requested
//      total instead of drifting by a few under naive rounding, and a band that cannot fill its
//      quota gives the remainder back to the others rather than silently shrinking the sample.
//   3. NOTHING IS SILENTLY EXCLUDED. Every caller-visible result states the band boundaries, the
//      per-band counts, and anything that could not be assigned and why.

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG. mulberry32 — small, fast, well-distributed, and above all REPEATABLE across
// processes and Node versions, which Math.random() is not (it is seeded from entropy and V8 is free
// to change the algorithm). The sample has to be defensible months later, not merely random today.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A text seed (a run label, a date) hashed to 32 bits, so the audit_log entry can carry something a
// human recognises instead of an opaque integer.
function seedFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  const s = String(value ?? '');
  let h = 2166136261 >>> 0;                        // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Fisher-Yates against the seeded stream. Returns a new array; the input is not mutated.
function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
/**
 * Cut the pool into `bandCount` score bands by QUANTILE, not by equal score width.
 *
 * Equal-width bands (0-20, 20-40, …) look tidier and are wrong here: PIS-7 composites cluster hard
 * in the middle, so fixed widths leave the tail bands nearly empty and the sample degenerates back
 * toward the middle — the exact bias stratification exists to remove. Quantiles put a comparable
 * number of PLEs in each band whatever the distribution turns out to be.
 *
 * Ties are kept together: a PLE cannot land in two bands, so an identical score always falls in the
 * same band, even when that leaves bands uneven.
 */
function bandPool(pool, bandCount = 5) {
  const sorted = pool.slice().sort((a, b) => a.score - b.score || String(a.id).localeCompare(String(b.id)));
  const n = sorted.length;
  if (!n) return { bands: [], boundaries: [] };

  const k = Math.max(1, Math.min(bandCount, n));
  const cuts = [];
  for (let i = 1; i < k; i++) cuts.push(sorted[Math.floor((i * n) / k)].score);

  const bands = Array.from({ length: k }, () => []);
  for (const item of sorted) {
    // Upper-exclusive against each cut; the last band absorbs everything at or above the last cut.
    let b = 0;
    while (b < cuts.length && item.score >= cuts[b]) b++;
    bands[b].push(item);
  }
  return {
    bands,
    boundaries: bands.map((rows, i) => ({
      band: i + 1,
      min: rows.length ? rows[0].score : null,
      max: rows.length ? rows[rows.length - 1].score : null,
      available: rows.length,
    })),
  };
}

/**
 * Largest-remainder allocation of `target` across bands, capped by what each band actually holds.
 *
 * TWO MODES, and the default is the non-obvious one:
 *
 *   'equal' (DEFAULT) — every band gets the same quota. This deliberately OVER-samples sparse bands
 *      relative to their frequency, which is the entire reason to stratify for a reliability
 *      estimate: we want comparable precision at the top and bottom of the score range, and the
 *      extremes are exactly where AI and auditor are most likely to disagree.
 *
 *   'proportional' — quota proportional to band size, preserving the population distribution. Use
 *      when the audited set must mirror the cohort rather than cover the range.
 *
 * Equal is the default because proportional silently defeats the purpose on a realistic
 * distribution: PIS-7 composites cluster hard in the middle, so with 44 PLEs of which 2 sit in the
 * bottom band, proportional allocation of 10 gives that band 10 x 2/44 = 0.45, which floors to ZERO.
 * The sample then contains no low-scoring PLE at all, while still being described as stratified.
 *
 * Naive `Math.round(target * w_i)` both misses the total and can hand a band more rows than it has.
 * This floors, distributes the remainder to the largest fractional parts, then re-runs whenever a cap
 * bites so the freed places go to bands that can still fill them.
 */
function allocate(sizes, target, mode = 'equal') {
  const k = sizes.length;
  const quota = new Array(k).fill(0);
  let remaining = Math.min(Math.max(0, target | 0), sizes.reduce((a, x) => a + x, 0));
  const open = sizes.map((s, i) => (s > 0 ? i : -1)).filter(i => i >= 0);

  let guard = 0;
  while (remaining > 0 && open.length && guard++ < 100) {
    // 'equal' weights every remaining band the same; 'proportional' weights by unfilled room.
    const weights = open.map(i => (mode === 'proportional' ? sizes[i] - quota[i] : 1));
    const W = weights.reduce((a, x) => a + x, 0);
    if (W <= 0) break;

    const exact = weights.map(w => (remaining * w) / W);
    const add = exact.map(x => Math.floor(x));
    const leftover = remaining - add.reduce((a, x) => a + x, 0);
    // Deterministic tie-break: larger fractional part first, then band order. Never a random pick —
    // two identical requests must produce identical quotas.
    const order = open.map((_, idx) => idx).sort((x, y) => (exact[y] - add[y]) - (exact[x] - add[x]) || x - y);
    for (let t = 0; t < leftover; t++) add[order[t % order.length]]++;

    for (let idx = 0; idx < open.length; idx++) {
      const i = open[idx];
      const give = Math.min(add[idx], sizes[i] - quota[i]);
      quota[i] += give;
      remaining -= give;
    }
    for (let idx = open.length - 1; idx >= 0; idx--) {
      if (quota[open[idx]] >= sizes[open[idx]]) open.splice(idx, 1);
    }
  }
  return quota;
}

/**
 * The draw.
 *
 * @param {Array<{id, score, forced?: boolean}>} pool  evaluated PLEs eligible for audit
 * @param {object} opts
 * @param {number} opts.target      how many PLEs to sample
 * @param {number|string} opts.seed reproducibility key
 * @param {number} [opts.bandCount] default 5 (quintiles)
 * @param {'equal'|'proportional'} [opts.allocation] default 'equal' — see allocate()
 * @returns {{ selected, seed, boundaries, per_band, forced_included, pool_size }}
 */
function stratifiedSample(pool, { target, seed, bandCount = 5, allocation = 'equal' }) {
  const seedInt = seedFrom(seed);
  const rng = mulberry32(seedInt);

  // Force-included PLEs (integrity-flagged) bypass the draw entirely and do NOT consume a band
  // quota. A flagged session must reach a human regardless of where its score landed, and letting it
  // eat a random slot would quietly shrink the random part of the sample — the part the ICC rests on.
  const forced = pool.filter(c => c.forced);
  const forcedIds = new Set(forced.map(c => c.id));
  const drawable = pool.filter(c => !forcedIds.has(c.id));

  const { bands, boundaries } = bandPool(drawable, bandCount);
  const quota = allocate(bands.map(b => b.length), Math.max(0, target | 0), allocation);

  const selected = [...forced];
  const per_band = [];
  bands.forEach((rows, i) => {
    const take = shuffle(rows, rng).slice(0, quota[i]);
    per_band.push({ ...boundaries[i], sampled: take.length });
    selected.push(...take);
  });

  return {
    selected,
    seed: seedInt,
    seed_input: seed ?? null,
    boundaries,
    per_band,
    forced_included: forced.length,
    pool_size: pool.length,
    allocation,
    // Stated explicitly rather than left for the caller to infer: asking for 40 out of a pool of 12
    // is not an error, but it must not silently look like a 40-case sample either.
    requested: Math.max(0, target | 0),
    shortfall: Math.max(0, Math.max(0, target | 0) - (selected.length - forced.length)),
  };
}

// ---------------------------------------------------------------------------------------------
/**
 * Is this auditor allowed to score this PLE? Extracted from routes/admin.js's /assign handler so the
 * sampler and the manual path cannot drift — a rule enforced in one of two places is a rule that
 * eventually is not enforced at all.
 *
 * Returns { ok: true } or { ok: false, reason } — reason is surfaced, never swallowed.
 */
function auditorEligibility(auditor, ple) {
  const canAudit = auditor && (auditor.role === 'auditor' || auditor.can_audit === true);
  if (!auditor || !canAudit || auditor.status !== 'active') return { ok: false, reason: 'not_an_active_auditor' };
  if (auditor.id === ple.physician_id) return { ok: false, reason: 'own_session' };
  if (auditor.council_id !== ple.council_id) return { ok: false, reason: 'cross_council' };
  // Enforced only when the session carries a specialty, so pre-migration PLEs still assign.
  if (ple.specialty_id && auditor.specialty_id !== ple.specialty_id) return { ok: false, reason: 'cross_specialty' };
  return { ok: true };
}

/**
 * Spread PLEs across auditors, `perPle` auditors each, as evenly as the eligibility rules allow.
 *
 * Round-robin from a seeded starting offset rather than always from index 0: a fixed start would
 * load the first auditor in the roster on every run.
 */
function assignRoundRobin(ples, auditors, { perPle = 1, seed = 0 } = {}) {
  const rng = mulberry32(seedFrom(seed) ^ 0x9E3779B9);
  const roster = shuffle(auditors, rng);
  const load = Object.fromEntries(roster.map(a => [a.id, 0]));
  const assignments = [];
  const unassignable = [];

  for (const ple of ples) {
    const eligible = roster.filter(a => auditorEligibility(a, ple).ok);
    if (!eligible.length) {
      // The known live gap: 3 auditors cover 3 of 19 physician specialties, so most specialties have
      // no eligible auditor at all. Report it per PLE — a sample that silently assigned 4 of 40 would
      // otherwise look like a successful run.
      unassignable.push({ ple_id: ple.id, reason: 'no_eligible_auditor' });
      continue;
    }
    // Least-loaded first, ties broken by roster order (already seed-shuffled) — keeps the spread even
    // without another random draw.
    const picks = eligible.sort((a, b) => load[a.id] - load[b.id]).slice(0, perPle);
    for (const a of picks) {
      load[a.id]++;
      assignments.push({ ple_id: ple.id, auditor_id: a.id });
    }
    if (picks.length < perPle) {
      unassignable.push({ ple_id: ple.id, reason: 'fewer_eligible_auditors_than_target', got: picks.length, wanted: perPle });
    }
  }
  return { assignments, unassignable, load };
}

module.exports = { mulberry32, seedFrom, shuffle, bandPool, allocate, stratifiedSample, auditorEligibility, assignRoundRobin };
