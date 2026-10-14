// Load what the PIS-7 evaluator needs for a PLE, server-side (the service-role key bypasses RLS, so
// reads are by ple_id only). One loader for the drain, the reconcile sweep and the admin approve path,
// so every background evaluation scores the SAME thing the physician's /end flow would have — including
// a reflection that arrived after the session ended.
const { supabase } = require('../lib/supabase');
const reflection = require('./reflection');

// chief_complaint: never sent to the model — RIMPL seeds its token numbering with it (rimpl-client.js).
const PLE_COLS = 'id, physician_id, status, council_id, is_test, socratic_reason, c1_pass, c2_pass, c3_pass, eval_attempts, eval_enqueued_at, chief_complaint';

// Returns { ple, transcript, patientRef, chiefComplaint }; null when the PLE row itself cannot be read;
// and { ple, transcript: null, reason: 'empty' | 'messages_error' | 'patient_ref_error' } when the row is
// fine but there is nothing safe to score — the caller must tell those apart: an EMPTY transcript will
// never grow (route to a human), a failed read is transient (retry). Never scores nothing into a bogus
// result, and never scores WITHOUT the scrub hints because their read failed: a missing hint is how an
// untitled patient name reaches the model.
async function loadTranscriptForEvaluation(pleId, { withReflection = true } = {}) {
  const { data: ple, error: pleErr } = await supabase.from('ples').select(PLE_COLS).eq('id', pleId).maybeSingle();
  if (pleErr || !ple) return null;
  const { data: msgs, error: msgErr } = await supabase
    .from('messages').select('role, content').eq('ple_id', pleId).order('created_at');
  if (msgErr) return { ple, transcript: null, patientRef: null, reason: 'messages_error' };
  if (!msgs?.length) return { ple, transcript: null, patientRef: null, reason: 'empty' };
  let transcript = msgs.map((m) => ({ role: m.role, content: m.content }));
  if (withReflection) transcript = await reflection.withReflection(pleId, transcript);
  // Patient identifier → scrubbed from the transcript on-prem before any model call. A READ ERROR is
  // transient and fails closed (the drain defers); NO ROW is simply a session with no patient_ref.
  const { data: pref, error: prefErr } = await supabase.from('ple_patient_refs').select('patient_ref').eq('ple_id', pleId).maybeSingle();
  if (prefErr) return { ple, transcript: null, patientRef: null, reason: 'patient_ref_error' };
  return { ple, transcript, patientRef: pref?.patient_ref ?? null, chiefComplaint: ple.chief_complaint ?? null };
}

module.exports = { loadTranscriptForEvaluation, PLE_COLS };
