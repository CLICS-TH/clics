// Load what the PIS-7 evaluator needs for a PLE, server-side (the service-role key bypasses RLS, so
// reads are by ple_id only). One loader for the drain, the reconcile sweep and the admin approve path,
// so every background evaluation scores the SAME thing the physician's /end flow would have — including
// a reflection that arrived after the session ended.
const { supabase } = require('../lib/supabase');
const reflection = require('./reflection');

const PLE_COLS = 'id, physician_id, status, council_id, is_test, socratic_reason, c1_pass, c2_pass, c3_pass, eval_attempts, eval_enqueued_at';

// Returns { ple, transcript, patientRef }; null when the PLE row itself cannot be read; and
// { ple, transcript: null, reason: 'empty' | 'messages_error' } when the row is fine but there is nothing
// to score — the caller must tell those apart: an EMPTY transcript will never grow (route to a human),
// a failed read is transient (retry). Never scores nothing into a bogus result.
async function loadTranscriptForEvaluation(pleId, { withReflection = true } = {}) {
  const { data: ple, error: pleErr } = await supabase.from('ples').select(PLE_COLS).eq('id', pleId).maybeSingle();
  if (pleErr || !ple) return null;
  const { data: msgs, error: msgErr } = await supabase
    .from('messages').select('role, content').eq('ple_id', pleId).order('created_at');
  if (msgErr) return { ple, transcript: null, patientRef: null, reason: 'messages_error' };
  if (!msgs?.length) return { ple, transcript: null, patientRef: null, reason: 'empty' };
  let transcript = msgs.map((m) => ({ role: m.role, content: m.content }));
  if (withReflection) transcript = await reflection.withReflection(pleId, transcript);
  // Patient identifier → scrubbed from the transcript on-prem before any model call.
  const { data: pref } = await supabase.from('ple_patient_refs').select('patient_ref').eq('ple_id', pleId).maybeSingle();
  return { ple, transcript, patientRef: pref?.patient_ref ?? null };
}

module.exports = { loadTranscriptForEvaluation, PLE_COLS };
