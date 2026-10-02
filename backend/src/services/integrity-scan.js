// Runs the integrity detector against a stored PLE and persists what it finds.
//
// services/integrity.js is PURE — arithmetic over data handed to it, no database, no clock — so that
// it can be tested against fixtures and reasoned about. This module is the half that touches the
// database, and it exists so the SAME scan can be triggered two ways: automatically when a session
// ends, and manually by an admin from the PLE detail screen.
//
// WHY AUTOMATIC MATTERS. CREC082 §1 excludes "passive copying of AI answers" from what counts as a
// PLE. The detector for that shipped in August and was reachable only from an admin button, so
// production had zero scans and the exclusion was, in practice, not enforced at all. A control that
// depends on somebody remembering to press it is not a control.
//
// PII CONSTRAINT — same as services/integrity.js, and it is the reason this is a separate module
// rather than something that could drift into a model call. This reads RAW physician text, including
// the physician's other sessions. It must stay inside the backend. Nothing here may ever call an AI.

const { supabase } = require('../lib/supabase');
const { detectIntegritySignals } = require('./integrity');

// The signals the detector itself produces. The scan replaces these wholesale on every run so a
// stale flag from an earlier sweep cannot sit beside current ones — but it must NOT delete signals
// raised elsewhere (the rescue post-check writes its own), which is why the delete is scoped by name
// rather than by ple_id alone.
const DETECTOR_SIGNALS = [
  'F1_NEAR_DUPLICATE', 'F2_CROSS_SESSION_REUSE', 'F3_PASTE_BURST',
  'F4_COMPOSITION_RATE', 'F5_LATENCY_UNIFORMITY',
  // Listed even though it ships disabled. A signal that is enabled, writes flags, and is then
  // switched off must have its old rows cleared by the next sweep; omitting it here would strand
  // them permanently, and a stale accusation is worse than none.
  'F6_REGISTER_DISCONTINUITY',
];

/**
 * Scan one PLE and persist its flags.
 *
 * @param {object}  args
 * @param {string}  args.pleId
 * @param {string}  args.physicianId    owner, for the cross-session comparison corpus
 * @returns {Promise<{flags: Array, scanned_turns: number, corpus_cles: number}>}
 * @throws on a database error — callers decide whether that is fatal. It is not, at /end.
 */
async function scanPle({ pleId, physicianId }) {
  const { data: messages, error: mErr } = await supabase.from('messages')
    .select('role, content, created_at, token_count').eq('ple_id', pleId).order('created_at');
  if (mErr) throw new Error(mErr.message);

  // Comparison corpus for F2: this physician's turns in their OTHER sessions.
  // Test sessions are EXCLUDED. The pilot's own rehearsal pasted the same scripted prompt into
  // several PLEs, and every cross-session duplicate observed in production came from exactly that;
  // leaving them in would flag the team's own testing as physician misconduct.
  let priorTurns = [], otherIds = [];
  if (physicianId) {
    const { data: otherPles } = await supabase.from('ples')
      .select('id').eq('physician_id', physicianId).eq('is_test', false).neq('id', pleId);
    otherIds = (otherPles ?? []).map(c => c.id);
    if (otherIds.length) {
      const { data: prior } = await supabase.from('messages')
        .select('ple_id, content').in('ple_id', otherIds).in('role', ['user', 'physician']);
      priorTurns = prior ?? [];
    }
  }

  const flags = detectIntegritySignals(messages ?? [], priorTurns);

  const { error: delErr } = await supabase.from('ple_integrity_flags')
    .delete().eq('ple_id', pleId).in('signal', DETECTOR_SIGNALS);
  if (delErr) throw new Error(delErr.message);

  if (flags.length) {
    const { error: insErr } = await supabase.from('ple_integrity_flags')
      .upsert(flags.map(f => ({ ple_id: pleId, ...f })), { onConflict: 'ple_id,signal' });
    if (insErr) throw new Error(insErr.message);
  }

  return { flags, scanned_turns: (messages ?? []).length, corpus_cles: otherIds.length };
}

// The rescue reply broke a commitment the protocol makes to the ethics committee: CREC082 §4 says
// the rescue asks 1-2 NON-LEADING questions and gives no diagnosis. The reply was already checked at
// the point it was generated, but the result only reached console.error — so "did any rescue turn
// give a diagnosis?" was a question the dataset could not answer, only the hosting provider's log
// retention could.
//
// 'medium', not 'high': the physician did nothing wrong here. This flags OUR output, and it routes
// the session to a human rather than accusing anyone.
async function flagRescueReplyBreach({ pleId, check, turn }) {
  const { error } = await supabase.from('ple_integrity_flags').upsert({
    ple_id: pleId,
    signal: 'R1_RESCUE_REPLY_BREACH',
    severity: 'medium',
    evidence: {
      turn: turn ?? null,
      question_count: check.questions,
      too_many_questions: !!check.tooManyQuestions,
      no_question: !!check.noQuestion,
      diagnostic: !!check.diagnostic,
      // The reply text is deliberately NOT stored here. It is already in `messages`, and copying it
      // into a flag row would duplicate raw physician-adjacent content for no added evidence.
      note: 'CREC082 §4: a rescue turn must ask 1-2 non-leading questions and give no diagnosis.',
    },
  }, { onConflict: 'ple_id,signal' });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------------------------------
// A physician reported an AI tutor reply as wrong or unsafe — the "safety event log" CREC082's Risk &
// Incident Plan commits to. It rides the same table as the detector's flags and the rescue post-check
// so it reaches the same reviewers through the same queue, but it is the one signal here that comes
// FROM the physician rather than ABOUT them.
//
// WHAT IT IS NOT. It is not an accusation, so it cannot be scored against the physician; it is not
// shown to the physician after the fact; and it must not steer the audit sample (routes/admin.js
// excludes it from the forced-inclusion set — a physician who could pull their own episodes into the
// audited subset would bias the very ICC that subset exists to estimate).
//
// ONE ROW PER PLE, MANY REPORTS INSIDE IT. The table is unique on (ple_id, signal), so separate
// reports on separate replies of one session are merged into evidence.reports[] rather than
// overwriting each other. Each entry carries the provider / model / prompt_version of the reply it is
// about, read server-side from `messages` — that attribution is the reason the log exists (which model
// said it?) and none of it is ever returned to the physician.
//
// PII CONSTRAINT. report.note is physician-typed free text and may carry identifiers. It stays in
// this row and nowhere else; nothing in this module may send it to a model.
const REPORTED_REPLY_SIGNAL = 'S1_PHYSICIAN_REPORTED_REPLY';

// Severity orders the reviewer's queue; it does not rank anyone. Only advice that could harm a patient
// is 'high'. The row carries the WORST severity across its reports.
const REPORT_SEVERITY = {
  unsafe_advice: 'high',
  wrong_fact: 'medium',
  fabricated_reference: 'medium',
  wrong_language: 'low',
  other: 'low',
};
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

// Bounds evidence.reports[] (a jsonb array that is rewritten on every report). A session that has
// genuinely hit 25 distinct unsafe replies needs a person, not a 26th entry.
const MAX_REPORTS_PER_PLE = 25;

async function readReports(pleId) {
  const { data, error } = await supabase.from('ple_integrity_flags')
    .select('severity, evidence').eq('ple_id', pleId).eq('signal', REPORTED_REPLY_SIGNAL).maybeSingle();
  if (error) throw new Error(error.message);
  return Array.isArray(data?.evidence?.reports) ? data.evidence.reports : [];
}

/**
 * Record one report. Idempotent per message: a second report on the same reply changes nothing and
 * returns 'duplicate' — the FIRST report (its reason and note) stands.
 *
 * @param {object} args
 * @param {string} args.pleId
 * @param {object} args.report  { message_id, reason, note?, turn?, provider, model, prompt_version }
 * @returns {Promise<'recorded'|'duplicate'|'limit'>}
 * @throws on a database error — the route turns that into a 500, because a safety report that
 *         vanishes silently is worse than one the physician is told failed.
 */
async function recordReportedReply({ pleId, report }) {
  const entry = {
    message_id: report.message_id,
    reason: report.reason,
    note: report.note ?? null,
    turn: report.turn ?? null,
    provider: report.provider ?? null,
    model: report.model ?? null,
    prompt_version: report.prompt_version ?? null,
    reported_at: new Date().toISOString(),
  };

  // Read-merge-write, then read BACK. Two reports on different replies of one session, landing in the
  // same few milliseconds, would each merge into the same stale array and the later write would drop
  // the earlier report. The read-back catches that for the loser and retries it. It cannot close the
  // window completely (that needs a row lock, i.e. an RPC and a migration) — it narrows a
  // milliseconds-wide race between two taps by one person to something that has not been seen.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reports = await readReports(pleId);
    if (reports.some((r) => r.message_id === entry.message_id)) return 'duplicate';
    if (reports.length >= MAX_REPORTS_PER_PLE) return 'limit';

    const next = [...reports, entry];
    const worst = next.reduce((a, r) => {
      const sev = REPORT_SEVERITY[r.reason] ?? 'low';
      return SEVERITY_RANK[sev] > SEVERITY_RANK[a] ? sev : a;
    }, 'low');

    const { error } = await supabase.from('ple_integrity_flags').upsert({
      ple_id: pleId,
      signal: REPORTED_REPLY_SIGNAL,
      severity: worst,
      evidence: {
        report_count: next.length,
        reports: next,
        note: 'A physician reported an AI reply as wrong or unsafe. This flags OUR output, not the physician.',
      },
    }, { onConflict: 'ple_id,signal' });
    if (error) throw new Error(error.message);

    const after = await readReports(pleId);
    if (after.some((r) => r.message_id === entry.message_id)) return 'recorded';
  }
  throw new Error('could not record the report: concurrent writes kept overwriting it');
}

module.exports = {
  scanPle, flagRescueReplyBreach, recordReportedReply,
  DETECTOR_SIGNALS, REPORTED_REPLY_SIGNAL, REPORT_SEVERITY, MAX_REPORTS_PER_PLE,
};
