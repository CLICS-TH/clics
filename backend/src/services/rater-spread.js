// Can the human raters discriminate at all? — the question that has to be answered before any ICC
// gate means anything.
//
// WHY THIS EXISTS. The 2026-08-28 baseline read ICC = -0.315 on n=5, and the cause was not the model.
// The five episodes were scored 74-80 by the humans and 71-91 by the AI: six points of human range
// across the whole corpus. ICC asks whether two raters RANK the same subjects the same way, and with
// six points of range there is almost nothing to rank. That is restriction of range, and no amount of
// evaluator tuning fixes it — but nothing in the product made it visible, so it read as "the AI
// disagrees with our experts".
//
// The arithmetic is the useful part. Treat one rating as true score plus error:
//
//     ICC  =  var_between / (var_between + var_error)
//
// so ICC >= 0.75 requires var_between >= 3 x var_error. Both terms are measurable today: var_error
// from how far two raters of the SAME episode sit apart, var_between from how far episodes sit apart.
// That turns "the raters need to spread out more" into a number — how much more, in score points.
//
// DESCRIPTIVE, NOT INFERENTIAL. Everything here is a summary of scores that exist. It makes no claim
// about a population, and at pilot n every figure is fragile; `n` travels with each one so nobody has
// to guess how much to believe it.
//
// NOTE ON THE TESTS. The hermetic suite mocks Supabase, so it returns whatever a test hands it and
// CANNOT catch a wrong column name — this file shipped selecting `created_at`, which does not exist
// on audit_scores (it is `scored_at`), and every test passed. Run it against the real database once
// after changing the select list.
const { supabase } = require('../lib/supabase');
const { ICC_DOMAINS } = require('./agreement');

// The per-domain anchor-clarity vocabulary, mirrored from lib/schemas.js ANCHOR_CLARITY.
const ANCHOR_VALUES = ['clear', 'moderate', 'ambiguous'];

const num = (v) => (v == null ? null : Number(v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Sample variance (n-1). Returns null below two values rather than 0: "one observation" and "no
// spread" are different findings, and reporting the first as the second is what hides a thin corpus.
function variance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}
const sd = (xs) => { const v = variance(xs); return v == null ? null : Math.sqrt(v); };
const round = (x, p = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** p) / 10 ** p);

/**
 * How much do raters of the SAME episode disagree?
 *
 * Only episodes with two or more raters carry this information: with one rater per episode there is
 * no within-episode comparison to make, and the corpus cannot say how noisy a single rating is.
 * Returned as null in that case rather than as zero — the honest answer is "unmeasurable here".
 */
function withinEpisode(byPle) {
  const spreads = [];
  let multiRated = 0;
  for (const scores of byPle.values()) {
    if (scores.length < 2) continue;
    multiRated++;
    // Half the pairwise mean absolute difference approximates the single-rating error SD's scale;
    // the variance below is what the gate arithmetic actually uses.
    const v = variance(scores.map((s) => s.composite));
    if (v != null) spreads.push(v);
  }
  return { varError: spreads.length ? mean(spreads) : null, multiRated };
}

/**
 * Per domain: is anyone using the scale?
 *
 * A domain where nearly every episode gets the same anchor contributes nothing to the composite's
 * ability to separate episodes, however carefully it was scored. `modal_share` is the fraction of
 * ratings landing on the single most-used value — at 1.0 the domain is a constant.
 */
// How clear the rater found each domain's behavioural anchor. The approved form asks it per domain
// and D22 puts the auditor surface BEFORE the calibration workshop precisely so this exists to read:
// a domain rated 'ambiguous' by everyone is a rubric problem, and it is a different fix from a domain
// everyone scores identically (which is a discrimination problem). Nullable — rows predating the
// field simply do not answer, and are counted separately rather than folded into 'clear'.
function anchorClarity(rows) {
  const out = {};
  for (const d of ICC_DOMAINS) {
    const vals = rows.map((r) => r[`${d}_anchor`]).filter((v) => v != null);
    const counts = Object.fromEntries(ANCHOR_VALUES.map((v) => [v, vals.filter((x) => x === v).length]));
    out[d] = {
      answered: vals.length,
      unanswered: rows.length - vals.length,
      ...counts,
      ambiguous_share: vals.length ? round(counts.ambiguous / vals.length) : null,
    };
  }
  return out;
}

function domainCollapse(rows) {
  const out = {};
  for (const d of ICC_DOMAINS) {
    const vals = rows.map((r) => num(r[d])).filter((v) => v != null);
    if (!vals.length) { out[d] = { n: 0, sd: null, modal_value: null, modal_share: null, distinct: 0 }; continue; }
    const counts = new Map();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [modalValue, modalCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    out[d] = {
      n: vals.length,
      sd: round(sd(vals)),
      modal_value: modalValue,
      modal_share: round(modalCount / vals.length),
      distinct: counts.size,
    };
  }
  return out;
}

/**
 * The whole picture, in one read.
 *
 * @returns {Promise<{ok: true, ...}|{ok: false, error: object}>} `ok:false` carries the db error for
 *   the caller to surface — returned rather than thrown so an express handler cannot die on it.
 */
async function raterSpread({ includeTest = false } = {}) {
  const [scoresRes, plesRes, aiRes] = await Promise.all([
    supabase.from('audit_scores').select(
      `ple_id, auditor_id, composite_score, ${ICC_DOMAINS.join(',')}, scored_at, ` +
      ICC_DOMAINS.map((d) => `${d}_anchor`).join(', ')),
    supabase.from('ples').select('id, is_test'),
    supabase.from('ai_evaluations').select('ple_id, composite_score'),
  ]);
  for (const r of [scoresRes, plesRes, aiRes]) if (r.error) return { ok: false, error: r.error };

  const testIds = new Set((plesRes.data ?? []).filter((c) => c.is_test).map((c) => c.id));
  const known = new Set((plesRes.data ?? []).map((c) => c.id));
  const inScope = (id) => known.has(id) && (includeTest || !testIds.has(id));

  const rows = (scoresRes.data ?? []).filter((r) => inScope(r.ple_id) && num(r.composite_score) != null);
  if (!rows.length) return { ok: true, empty: true, n_scores: 0 };

  // --- per episode, and per auditor -------------------------------------------------------------
  const byPle = new Map();
  const byAuditor = new Map();
  for (const r of rows) {
    const s = { composite: num(r.composite_score), auditor: r.auditor_id, at: r.scored_at };
    if (!byPle.has(r.ple_id)) byPle.set(r.ple_id, []);
    byPle.get(r.ple_id).push(s);
    if (!byAuditor.has(r.auditor_id)) byAuditor.set(r.auditor_id, []);
    byAuditor.get(r.auditor_id).push(s);
  }

  // One human value per episode, exactly as the ICC arms pair them — so the variance reported here
  // is the variance the gate actually sees, not a different number computed a different way.
  const episodeMeans = [...byPle.values()].map((ss) => mean(ss.map((s) => s.composite)));
  const varBetween = variance(episodeMeans);
  const { varError, multiRated } = withinEpisode(byPle);

  // --- the gate arithmetic ----------------------------------------------------------------------
  // ICC = var_between / (var_between + var_error)  =>  0.75 needs var_between >= 3 x var_error.
  // Reported in SCORE POINTS, because "raise the between-episode SD to 12 points" is actionable and
  // "raise var_between to 144" is not.
  let gate = { measurable: false, why: null };
  if (varError == null) {
    gate.why = multiRated === 0
      ? 'no episode has two or more raters, so single-rating error cannot be measured from this corpus'
      : 'too few multi-rated episodes to estimate rater error';
  } else if (varError === 0) {
    gate = { measurable: false, why: 'raters of the same episode agree exactly — error variance is 0, so no spread requirement follows' };
  } else {
    const requiredBetween = 3 * varError;
    gate = {
      measurable: true,
      why: null,
      sd_error: round(Math.sqrt(varError)),
      sd_between_observed: round(varBetween == null ? null : Math.sqrt(varBetween)),
      sd_between_required: round(Math.sqrt(requiredBetween)),
      meets: varBetween != null && varBetween >= requiredBetween,
    };
  }

  // --- how much of the scale is being used ------------------------------------------------------
  const humanAll = rows.map((r) => num(r.composite_score));
  const aiByPle = new Map((aiRes.data ?? []).filter((a) => inScope(a.ple_id)).map((a) => [a.ple_id, num(a.composite_score)]));
  const sharedIds = [...byPle.keys()].filter((id) => aiByPle.has(id));
  const aiShared = sharedIds.map((id) => aiByPle.get(id)).filter((v) => v != null);
  const humanShared = sharedIds.map((id) => mean(byPle.get(id).map((s) => s.composite)));

  return {
    ok: true,
    empty: false,
    n_scores: rows.length,
    n_episodes: byPle.size,
    n_auditors: byAuditor.size,
    n_multi_rated_episodes: multiRated,
    // The headline: how far apart the EPISODES are, which is what an ICC has to work with.
    between_episodes: {
      sd: round(varBetween == null ? null : Math.sqrt(varBetween)),
      min: round(Math.min(...episodeMeans)),
      max: round(Math.max(...episodeMeans)),
      range: round(Math.max(...episodeMeans) - Math.min(...episodeMeans)),
    },
    // Same episodes, the other rater. A wide AI spread against a narrow human one is the signature
    // of restriction of range rather than of the two disagreeing about which episode is better.
    comparison_on_shared: {
      n: sharedIds.length,
      human_sd: round(sd(humanShared)),
      ai_sd: round(sd(aiShared)),
      human_range: humanShared.length ? round(Math.max(...humanShared) - Math.min(...humanShared)) : null,
      ai_range: aiShared.length ? round(Math.max(...aiShared) - Math.min(...aiShared)) : null,
    },
    gate,
    scale_use: {
      min: round(Math.min(...humanAll)),
      max: round(Math.max(...humanAll)),
      // The composite is 0-100. Using 6 points of it is the finding, not a detail.
      span_pct_of_scale: round(((Math.max(...humanAll) - Math.min(...humanAll)) / 100) * 100, 1),
    },
    per_domain: domainCollapse(rows),
    anchor_clarity: anchorClarity(rows),
    // Context, not inference: at pilot n a trend over time would be noise, so only the span is given.
    scored_between: (() => {
      const ts = rows.map((r) => r.scored_at).filter(Boolean).sort();
      return ts.length ? { first: ts[0], last: ts[ts.length - 1] } : null;
    })(),
    // Per auditor, so a single rater flattening the scale is distinguishable from everyone doing it.
    // Identified by id: these roles never see transcripts, and a name is not needed to read a spread.
    per_auditor: [...byAuditor.entries()].map(([id, ss]) => ({
      auditor_id: id,
      n: ss.length,
      mean: round(mean(ss.map((s) => s.composite))),
      sd: round(sd(ss.map((s) => s.composite))),
      min: round(Math.min(...ss.map((s) => s.composite))),
      max: round(Math.max(...ss.map((s) => s.composite))),
    })).sort((a, b) => b.n - a.n),
  };
}

module.exports = { raterSpread, variance, domainCollapse, anchorClarity };
