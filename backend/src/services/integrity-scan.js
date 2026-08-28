// Runs the integrity detector against a stored CLE and persists what it finds.
//
// services/integrity.js is PURE — arithmetic over data handed to it, no database, no clock — so that
// it can be tested against fixtures and reasoned about. This module is the half that touches the
// database, and it exists so the SAME scan can be triggered two ways: automatically when a session
// ends, and manually by an admin from the CLE detail screen.
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
// rather than by cle_id alone.
const DETECTOR_SIGNALS = [
  'F1_NEAR_DUPLICATE', 'F2_CROSS_SESSION_REUSE', 'F3_PASTE_BURST',
  'F4_COMPOSITION_RATE', 'F5_LATENCY_UNIFORMITY',
];

/**
 * Scan one CLE and persist its flags.
 *
 * @param {object}  args
 * @param {string}  args.cleId
 * @param {string}  args.physicianId    owner, for the cross-session comparison corpus
 * @returns {Promise<{flags: Array, scanned_turns: number, corpus_cles: number}>}
 * @throws on a database error — callers decide whether that is fatal. It is not, at /end.
 */
async function scanCle({ cleId, physicianId }) {
  const { data: messages, error: mErr } = await supabase.from('messages')
    .select('role, content, created_at, token_count').eq('cle_id', cleId).order('created_at');
  if (mErr) throw new Error(mErr.message);

  // Comparison corpus for F2: this physician's turns in their OTHER sessions.
  // Test sessions are EXCLUDED. The pilot's own rehearsal pasted the same scripted prompt into
  // several CLEs, and every cross-session duplicate observed in production came from exactly that;
  // leaving them in would flag the team's own testing as physician misconduct.
  let priorTurns = [], otherIds = [];
  if (physicianId) {
    const { data: otherCles } = await supabase.from('cles')
      .select('id').eq('physician_id', physicianId).eq('is_test', false).neq('id', cleId);
    otherIds = (otherCles ?? []).map(c => c.id);
    if (otherIds.length) {
      const { data: prior } = await supabase.from('messages')
        .select('cle_id, content').in('cle_id', otherIds).in('role', ['user', 'physician']);
      priorTurns = prior ?? [];
    }
  }

  const flags = detectIntegritySignals(messages ?? [], priorTurns);

  const { error: delErr } = await supabase.from('cle_integrity_flags')
    .delete().eq('cle_id', cleId).in('signal', DETECTOR_SIGNALS);
  if (delErr) throw new Error(delErr.message);

  if (flags.length) {
    const { error: insErr } = await supabase.from('cle_integrity_flags')
      .upsert(flags.map(f => ({ cle_id: cleId, ...f })), { onConflict: 'cle_id,signal' });
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
async function flagRescueReplyBreach({ cleId, check, turn }) {
  const { error } = await supabase.from('cle_integrity_flags').upsert({
    cle_id: cleId,
    signal: 'R1_RESCUE_REPLY_BREACH',
    severity: 'medium',
    evidence: {
      turn: turn ?? null,
      questions: check.questions,
      too_many_questions: !!check.tooManyQuestions,
      no_question: !!check.noQuestion,
      diagnostic: !!check.diagnostic,
      // The reply text is deliberately NOT stored here. It is already in `messages`, and copying it
      // into a flag row would duplicate raw physician-adjacent content for no added evidence.
      note: 'CREC082 §4: a rescue turn must ask 1-2 non-leading questions and give no diagnosis.',
    },
  }, { onConflict: 'cle_id,signal' });
  if (error) throw new Error(error.message);
}

module.exports = { scanCle, flagRescueReplyBreach, DETECTOR_SIGNALS };
