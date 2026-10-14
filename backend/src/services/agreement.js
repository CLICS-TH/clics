// Building the paired score sets the three-arm agreement comparison runs on.
//
// Extracted from routes/oversight.js so the Model Lock route can ask the SAME question — "does the
// candidate clear the decisive threshold?" — without a second implementation of it. A duplicate
// would drift, and the two places it drifts between are the screen a human reads and the gate that
// freezes the study's measuring instrument. Those disagreeing is the worst possible outcome.
//
// Everything here is data assembly plus arithmetic. It performs no authorization: both callers are
// already behind role guards, and putting a second, weaker check here would invite someone to rely
// on it.

const { supabase } = require('../lib/supabase');
const { iccTwoRater, verdictFor } = require('./icc');
const { iccGates } = require('../lib/settings');
const { evaluateClass } = require('../lib/ai-providers');

const ICC_DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SHADOW_COLS = 'ple_id, provider, model_version, composite_score, d1,d2,d3,d4,d5,d6,d7, error, evaluated_at';

// PostgREST reports an unapplied migration as a missing relation. That is a KNOWN state, not a
// fault: db/migration-shadow-evaluations.sql is deliberately unapplied in some environments, and it
// is indistinguishable from "no candidate corpus yet".
// Widened back to what routes/oversight.js checked before this function was extracted from it. The
// extraction quietly dropped PGRST106, the `hint` field, and "could not find the table" — and
// db/migration-shadow-evaluations.sql is still unapplied in production, so this predicate is the
// only thing standing between a genuinely absent table and a 500 on a live screen.
function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === 'PGRST205' || code === 'PGRST106' || code === '42P01') return true;
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table') || msg.includes('schema cache');
}

/**
 * Assemble the human / incumbent / candidate score sets over the audited universe.
 *
 * @returns {Promise<{ok: true, ...}|{ok: false, error: object}>} `ok:false` carries the db error for
 *   the caller to surface — this returns rather than throws so an express handler cannot die
 *   silently mid-response (this router has no error middleware; a throw hangs the client).
 */
async function pairedSets({ includeTest = false } = {}) {
  const { data: auditScores, error: auditErr } = await supabase
    .from('audit_scores').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (auditErr) return { ok: false, error: auditErr };
  if (!auditScores?.length) {
    return { ok: true, empty: true, humanBy: new Map(), aiBy: new Map(), shadowBy: new Map(),
      withAi: [], allThree: [], compareIds: [], candidate: null, shadowAvailable: false, shadowFailed: 0, shadowIneligible: 0 };
  }

  const scoredIds = [...new Set(auditScores.map(a => a.ple_id))];
  const { data: aiScores, error: aiErr } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', scoredIds);
  if (aiErr) return { ok: false, error: aiErr };
  const { data: ples, error: plesErr } = await supabase.from('ples').select('id, is_test').in('id', scoredIds);
  if (plesErr) return { ok: false, error: plesErr };

  const testOf = Object.fromEntries((ples ?? []).map(p => [p.id, p.is_test]));
  const inScope = (pleId) => includeTest || !testOf[pleId];

  const shadowRes = await supabase.from('shadow_evaluations').select(SHADOW_COLS).in('ple_id', scoredIds);
  if (shadowRes.error && !isMissingRelation(shadowRes.error)) return { ok: false, error: shadowRes.error };

  // One human value per PLE (mean across auditors) BEFORE pairing — ICC(2,1) assumes one rating per
  // subject per rater, so a multi-auditor PLE must contribute ONE pair, not N pairs reusing the same
  // AI value. With a single auditor the mean equals that score (correct in both modes).
  const byPle = new Map();
  for (const a of auditScores) {
    if (!inScope(a.ple_id)) continue;
    if (!byPle.has(a.ple_id)) byPle.set(a.ple_id, []);
    byPle.get(a.ple_id).push(a);
  }
  const humanBy = new Map();
  for (const [pleId, rows] of byPle) {
    const mean = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0) / rows.length;
    const human = { composite_score: mean('composite_score') };
    for (const d of ICC_DOMAINS) human[d] = mean(d);
    humanBy.set(pleId, human);
  }
  const aiBy = new Map((aiScores ?? []).filter(s => inScope(s.ple_id)).map(s => [s.ple_id, s]));

  // ONE candidate per arm. `provider` is the TRANSPORT ('local'), not the candidate — a second
  // candidate model on the same transport is a SEPARATE paired set. Pooling two models into one arm
  // would report a number that describes neither, so pick the most recent (provider, model_version).
  //
  // ONLY from a provider that may serve `evaluate` (lib/ai-providers.js evaluateClass). The candidate
  // chosen here is what POST /admin/evaluator-lock freezes as the study's measuring instrument, and
  // the tutor model (`local-tutor`) must never be that: CCME R3 needs the evaluator to be a distinct
  // artifact from the tutor. rimpl already refuses to write such rows; a row that exists anyway (an
  // older rimpl, a hand insert) is left out of every arm and COUNTED, not silently dropped.
  const groups = new Map();
  let shadowIneligible = 0;
  for (const r of (shadowRes.data ?? [])) {
    if (!inScope(r.ple_id)) continue;
    if (!evaluateClass(r.provider)) { shadowIneligible++; continue; }
    const key = `${r.provider} ${r.model_version}`;
    const g = groups.get(key) ?? { provider: r.provider, model_version: r.model_version, rows: [], latest: 0 };
    g.rows.push(r);
    g.latest = Math.max(g.latest, Date.parse(r.evaluated_at ?? '') || 0);
    groups.set(key, g);
  }
  const candidate = [...groups.values()].sort((x, y) =>
    (y.latest - x.latest) || String(y.model_version ?? '').localeCompare(String(x.model_version ?? '')))[0] ?? null;

  // A row with `error` set carries no scores, so it cannot enter an ICC — but it IS counted, because
  // "the candidate could not produce a valid score set 8% of the time" is a first-class, potentially
  // disqualifying result. Averaging it away would hide the thing a swap decision hinges on.
  const shadowBy = new Map();
  let shadowFailed = 0;
  for (const r of candidate?.rows ?? []) {
    if (r.error != null || r.d1 == null) { shadowFailed++; continue; }
    shadowBy.set(r.ple_id, r);
  }
  const shadowAvailable = shadowBy.size > 0;

  // COMPARABILITY. All arms are computed on the SAME PLEs — the intersection of human + ai + a
  // SCORED candidate row — so the three numbers can honestly be read against each other.
  const withAi = [...humanBy.keys()].filter(id => aiBy.has(id));
  const allThree = withAi.filter(id => shadowBy.has(id));

  return {
    ok: true, empty: false,
    humanBy, aiBy, shadowBy, withAi, allThree,
    compareIds: shadowAvailable ? allThree : withAi,
    candidate, shadowAvailable, shadowFailed, shadowIneligible,
  };
}

// The candidate-vs-human ICC over the shared set — the arm the Model Lock gates on.
function decisiveOverall(sets) {
  if (!sets?.shadowAvailable) return null;
  const pairs = sets.compareIds
    .map(id => ({ a: sets.shadowBy.get(id), b: sets.humanBy.get(id) }))
    .filter(p => p.a && p.b);
  return iccTwoRater(pairs.map(p => ({ a: Number(p.a.composite_score), b: Number(p.b.composite_score) })));
}

/**
 * Has the candidate cleared the DECISIVE bar? The one question the Model Lock is allowed to ask.
 *
 * Deliberately not the screening bar. Screening is candidate-vs-incumbent and can only reject —
 * two models agreeing closely can be similarly wrong, and freezing the study's measuring instrument
 * against a number that never touched a human judgement is exactly what this must prevent.
 */
async function decisiveVerdict({ includeTest = false } = {}) {
  const sets = await pairedSets({ includeTest });
  if (!sets.ok) return { ok: false, error: sets.error };
  const gates = await iccGates();
  return {
    ok: true,
    verdict: verdictFor(decisiveOverall(sets), gates.decisive),
    candidate: sets.candidate ? { provider: sets.candidate.provider, model_version: sets.candidate.model_version } : null,
  };
}

module.exports = { pairedSets, decisiveOverall, decisiveVerdict, isMissingRelation, ICC_DOMAINS, SHADOW_COLS };
