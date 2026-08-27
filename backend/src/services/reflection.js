// Post-PLE reflection (CREC082 ICF §3 step 3, PLE Instruction Sheet §3, Protocol V4.1).
//
// THE POINT THAT DRIVES THE WHOLE DESIGN: the reflection is scored evidence, not a survey.
//
// The protocol assesses PIS-7 on "หลักฐานที่ปรากฏใน transcript และ reflection ของ PLE", and the D6
// anchor begins "0: ไม่มี reflection". c6 (reflective synthesis) is also one of the four elements
// that decide whether the session qualifies as a PLE at all. So a reflection collected after
// screening — or stored where the evaluator never reads it — would leave both judged on evidence
// the protocol says is incomplete, and would do it silently.
//
// That is why /end no longer finalises immediately when a reflection is pending. The session rests
// at 'ended', which is already the system's recoverable state for "tier-1 done, tier-2 not yet", and
// finalisation happens when the reflection arrives (or is skipped). Nothing new had to be invented
// for the failure case: reconcile's existing sweep picks up any session abandoned there.
const { supabase } = require('../lib/supabase');

// The protocol's own three prompts, from PLE Instruction Sheet §3:
// "จบด้วย reflection ว่าเรียนรู้อะไร ความไม่แน่นอนอะไร และจะตรวจสอบ/นำไปใช้อย่างไร"
const PROMPTS = ['learned', 'uncertainty', 'application'];

async function getFor(cleId) {
  const { data } = await supabase.from('ple_reflections')
    .select('id, learned, uncertainty, application, skipped, submitted_at')
    .eq('cle_id', cleId).maybeSingle();
  return data ?? null;
}

// Record a reflection (or a deliberate skip). Idempotent on cle_id: a double-submit from two tabs
// updates rather than erroring, because the physician's second click should not look like a failure.
async function save({ cleId, physicianId, learned, uncertainty, application, skipped = false }) {
  const row = {
    cle_id: cleId, physician_id: physicianId, skipped: !!skipped,
    learned: skipped ? null : (learned ?? null),
    uncertainty: skipped ? null : (uncertainty ?? null),
    application: skipped ? null : (application ?? null),
    submitted_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('ple_reflections').upsert(row, { onConflict: 'cle_id' });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Turn a reflection into the transcript turn the evaluator scores.
//
// Appended with role 'reflection', which rimpl's flattenForPrompt renders as "[REFLECTION]:" — so
// the evaluator can tell it apart from a chat turn instead of reading it as more conversation. That
// distinction matters: the rubric asks whether the physician reflected, not whether they said more.
//
// A skipped or absent reflection appends NOTHING. Appending "(skipped)" would be putting words in
// the physician's mouth and could read to the model as content; an absent reflection should score as
// the D6 anchor says — "0: ไม่มี reflection" — which is what an empty tail produces on its own.
function asTranscriptTurn(reflection) {
  if (!reflection || reflection.skipped) return null;
  const parts = [
    reflection.learned && `เรียนรู้อะไร / What I learned:\n${reflection.learned}`,
    reflection.uncertainty && `ความไม่แน่นอน / What remains uncertain:\n${reflection.uncertainty}`,
    reflection.application && `จะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:\n${reflection.application}`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return { role: 'reflection', content: parts.join('\n\n') };
}

// The transcript a screening or evaluation call should see: the conversation, then the reflection.
async function withReflection(cleId, transcript) {
  const turn = asTranscriptTurn(await getFor(cleId));
  return turn ? [...transcript, turn] : transcript;
}

module.exports = { PROMPTS, getFor, save, asTranscriptTurn, withReflection };
