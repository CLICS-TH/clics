// Shared read access to the app_settings bag (superadmin-managed). Kept tiny + fail-soft so a
// missing key / pre-migration env falls back to the default instead of throwing.
const { supabase } = require('./supabase');

async function getSetting(key, def = null) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  const v = Number(data?.value);
  return Number.isFinite(v) ? v : def;
}

// Text-valued settings (provider names, ISO timestamps) live in app_settings.value_text — the
// `value` column is `numeric not null` and cannot hold them. See db/migration-provider-switch.sql.
// An empty string reads as "unset" so a superadmin can hand a setting back to its env default
// without deleting the row.
async function getTextSetting(key, def = null) {
  try {
    const { data, error } = await supabase.from('app_settings').select('value_text').eq('key', key).maybeSingle();
    // Pre-migration (no value_text column) this errors rather than returning null. Fall back to the
    // default instead of throwing: the same fail-soft contract getSetting() has always had.
    if (error) return def;
    const v = typeof data?.value_text === 'string' ? data.value_text.trim() : '';
    return v || def;
  } catch { return def; }
}

// The same read, WITHOUT the default. For a setting whose value decides something that must not be
// guessed: the evaluator lock state. getTextSetting turns a failed read into "unset", and for
// evaluator_locked_at "unset" means "unlocked" — so a database blip could let an evaluator switch
// through while the lock was in force, and stamp a post-lock score `locked: false`.
//
// Returns { value } (null when the row is absent or blank — a genuinely unset setting) or { error }.
// Never throws, never substitutes anything for an error: the caller decides what failing closed means.
async function getTextSettingStrict(key) {
  try {
    const { data, error } = await supabase.from('app_settings').select('value_text').eq('key', key).maybeSingle();
    if (error) return { error };
    const v = typeof data?.value_text === 'string' ? data.value_text.trim() : '';
    return { value: v || null };
  } catch (e) {
    return { error: { message: e?.message || String(e) } };
  }
}

// Pilot Test Mode (CLICS pilot): when ON, PLE creation produces TEST sessions, bypasses the 3-PLE
// study cap, and honours a physician-chosen Socratic mode — so the team can exercise the experiment.
async function pilotTestMode() {
  return (await getSetting('pilot_test_mode', 0)) === 1;
}

// Clinical Artifacts (superadmin toggle): when ON, the chat call tells RIMPL it may emit
// `:::artifact{...}` side-panel blocks. Default OFF — a research-stimulus change, enabled deliberately.
async function clinicalArtifactsEnabled() {
  return (await getSetting('clinical_artifacts', 0)) === 1;
}

// Chat streaming (superadmin setting `chat_streaming`, default OFF): when ON, a physician-ui turn that
// asks for it gets the reply word by word (server-sent events) instead of all at once. Off restores the
// whole-reply behaviour for everyone, with no deploy.
async function chatStreamingEnabled() {
  return (await getSetting('chat_streaming', 0)) === 1;
}

// Evidence-level marker (app setting `chat_evidence_marker`, default OFF; CCME requirement R5): when ON,
// the chat call tells RIMPL to make every non-rescue tutor reply carry exactly one evidence-level line
// (ระดับหลักฐานของข้อแนะนำหลัก: … (Evidence for the main recommendation: …) — GRADE high/moderate/low, expert
// opinion, or not graded), which RIMPL checks and folds into its single corrective retry. Needs the
// clinician check in docs/QUALITY-GATES.md before it is switched on. A
// tutor-prompt change, so it is a research-stimulus change like clinical_artifacts: switched on
// deliberately. The evaluator prompt is untouched. Off sends RIMPL exactly the prompt it sends today.
async function chatEvidenceMarkerEnabled() {
  return (await getSetting('chat_evidence_marker', 0)) === 1;
}

// Chat router (app setting `chat_router_enabled`, default OFF): when ON, RIMPL picks a tier per turn
// (fast | deep — how much thinking the tutor model gets) and reports it in `middleware_flags`. The
// backend forwards the setting as `router_enabled`, stores the flags on the assistant row
// (messages.middleware_flags) and latches ples.deep_mode_at the first time a session gets a deep turn
// with thinking applied, so it stays deep (`deep_mode`). Off sends RIMPL `router_enabled: false` and a turn is answered exactly
// as it is today. A tutor-behaviour change, so like clinical_artifacts it is switched on deliberately.
async function chatRouterEnabled() {
  return (await getSetting('chat_router_enabled', 0)) === 1;
}

// Peer Calibration (superadmin toggle): when ON, a PLE may be assigned to several auditors and the
// auditor reveal pane shows a you-vs-auditor-average PIS-7 radar. Default OFF (single-auditor blind audit).
async function peerCalibrationEnabled() {
  return (await getSetting('peer_calibration', 0)) === 1;
}

// Calibration reveal lock (superadmin toggle, for a calibration ROUND): when ON, an auditor is shown
// no AI score, no AI discussion, no peer average and no vs-AI agreement figure — for the whole round,
// not just until they submit.
//
// The per-PLE blind is already enforced: nothing reveals before THIS auditor has scored THIS session.
// That is not the same as a blinded round. A rater who scores PLE #1, sees the AI land three points
// below them, and then scores PLE #2 is no longer scoring independently — and the number a
// calibration round exists to produce is exactly the one that assumption underwrites. The lock is
// lifted by the coordinator once every rater has closed their scores.
//
// Default OFF: outside a calibration round the reveal is the auditor's own feedback loop and there is
// no reason to withhold it.
async function calibrationRevealLocked() {
  return (await getSetting('calibration_reveal_locked', 0)) === 1;
}

// Hold Result Until Audited (superadmin toggle, for a blinded test round): when ON, a physician's
// PIS-7 score is withheld (shown as "under expert review") until an expert auditor has submitted a
// score for that PLE — so physicians can't see/compare scores before review. Default OFF.
async function holdResultUntilAudited() {
  return (await getSetting('hold_result_until_audited', 0)) === 1;
}

// Minimum auditors per PLE (superadmin dial, default 1). The manuscript describes >= 3 blinded
// auditors per PLE; staffing does not support that yet (3 auditors cover 3 of 19 physician
// specialties). So this WARNS, it does not BLOCK: a PLE below target is badged in the admin queue
// and reported in the ICC cohort, but its score still releases. Blocking would strand credit for
// specialties that have no eligible auditor at all — a worse failure than a thin rater count.
// Socratic remediation after 3 consecutive Tier-1 failures. OFF by default and deliberately so:
// the CREC082 protocol describes exactly one route into Socratic mode — the mid-session rescue after
// 4 exchanges (PLE Instruction Sheet §4) — and says nothing about a cross-session remediation rule.
// The rule is a reasonable support path, but switching it on is a protocol deviation that someone
// has to choose and be able to point at afterwards, which a default-off setting records and a
// hardcoded `if` does not.
async function t1RemediationEnabled() {
  return (await getSetting('t1_remediation_enabled', 0)) === 1;
}

// The 100% human privacy review gate (CREC082 ICF §5-6). ON by default: the protocol promises a
// human reads every transcript before it reaches an expert rater, so the safe default is the one
// that keeps that promise. A superadmin can lower it, which is a recorded deviation rather than a
// silent omission.
async function privacyReviewRequired() {
  return (await getSetting('privacy_review_required', 1)) === 1;
}

// Professional identity verification before a physician's first PLE (CREC082 ICF §4).
//
// OFF by default, and unlike privacyReviewRequired that is deliberate rather than cautious. The
// privacy gate fails closed by WITHHOLDING data from third parties; this one fails closed by
// blocking every physician from working, and it guards nothing that is not already guarded while
// there are no real participants. It must be switched ON before the first participant — a release
// step, not a default. See db/migration-crec-identity.sql.
async function identityVerificationRequired() {
  return (await getSetting('identity_verification_required', 0)) === 1;
}

// Post-PLE reflection (CREC082 ICF §3 step 3). ON by default: the protocol promises it after every
// PLE and it is scored evidence for D6/c6. Unlike the identity gate this blocks nobody — a physician
// may always skip — so defaulting to the protocol's answer costs nothing.
async function reflectionRequired() {
  return (await getSetting('reflection_required', 1)) === 1;
}

// The DECLARED weights checksum from the CREC082 Model Lock Record (§10.2). Text, because it is a
// hex digest. NULL until the evaluator is locked — and a score produced before that says so on its
// face rather than implying a lock that had not happened.
//
// STRICT: { value } or { error }, never a default. Every score's provenance.locked is computed from it
// (rimpl provenance.js: locked = !!weights_sha256), so a read error mapped to null (the old behaviour)
// stamped a post-lock score `locked: false` for good: ai_evaluations is written once per PLE. The
// caller (services/ple-evaluation.js) defers the evaluation instead.
async function evaluatorWeightsSha256() {
  return getTextSettingStrict('evaluator_weights_sha256');
}

// The two agreement gates a candidate evaluator must clear, as configuration.
//
// SCREENING is candidate-vs-incumbent: runnable today, before a single human rater exists, and its
// only job is to reject a candidate cheaply before anyone spends effort on it. It is NOT evidence of
// correctness — two models can agree closely and both be wrong the same way — which is why it cannot
// be the last gate.
//
// DECISIVE is candidate-vs-human, and the human raters are the reference standard. Nothing is frozen
// against a number that never touched a human judgement.
async function iccGates() {
  const { data } = await supabase.from('app_settings').select('key, value')
    .in('key', ['icc_gate_screening', 'icc_gate_decisive']);
  const by = Object.fromEntries((Array.isArray(data) ? data : []).map(r => [r.key, Number(r.value)]));
  const clamp = (v, d) => (Number.isFinite(v) && v > 0 && v <= 1 ? v : d);
  return {
    screening: clamp(by.icc_gate_screening, 0.75),
    decisive: clamp(by.icc_gate_decisive, 0.75),
  };
}

// The transcript-size cap, in tokens of context (the LAST turn's prompt+completion — what the model
// actually sees — not the quadratic Σ of per-call counts). Bounded because the evaluator's context is
// finite and because every chat turn re-sends the whole transcript, so latency grows with it. 64k is
// the user's trial value; the shipped default comes from the capacity probe (docs/GATE0-DGX-RESULTS.md).
async function transcriptCap() {
  let data = null;
  try {
    ({ data } = await supabase.from('app_settings').select('key, value')
      .in('key', ['ple_max_transcript_tokens', 'ple_transcript_warn_pct']));
  } catch { data = null; } // fail-soft to the documented defaults — this sits on every chat turn
  const v = Object.fromEntries((Array.isArray(data) ? data : []).map(r => [r.key, Number(r.value)]));
  const limit = Number.isFinite(v.ple_max_transcript_tokens) && v.ple_max_transcript_tokens > 0 ? Math.round(v.ple_max_transcript_tokens) : 64000;
  const warnPct = Number.isFinite(v.ple_transcript_warn_pct) ? Math.min(95, Math.max(50, Math.round(v.ple_transcript_warn_pct))) : 80;
  return { limit, warnPct };
}

async function minAuditorsPerPle() {
  const n = await getSetting('min_auditors_per_cle', 1);
  return Math.max(1, Math.min(10, Math.round(n)));
}

// The credit-conversion policy, as data. Ships with credit_conversion_enabled = 0, so the physician
// UI shows the band as a PREVIEW and the existing "ยังไม่นับเป็นหน่วยกิต CME" wording is unchanged.
// One batched read: this sits on the PLE-result path, and eleven sequential awaits would not.
async function creditSettings() {
  const { data } = await supabase.from('app_settings').select('key, value')
    .in('key', ['credit_conversion_enabled', 'credit_base_unit',
      'credit_cut_1', 'credit_cut_2', 'credit_cut_3', 'credit_cut_4',
      'credit_value_1', 'credit_value_2', 'credit_value_3', 'credit_value_4', 'credit_value_5']);
  // Array.isArray, not `?? []`: this read sits on the physician's result page, and anything other
  // than a row array (a PostgREST error envelope, a pre-migration response) would otherwise throw
  // inside an async handler — which returns no response at all, so the page hangs rather than
  // showing a score the physician has already earned. Degrade to the documented defaults instead.
  const v = Object.fromEntries((Array.isArray(data) ? data : []).map(r => [r.key, Number(r.value)]));
  const has = (k) => Number.isFinite(v[k]);
  return {
    enabled: v.credit_conversion_enabled === 1,
    baseUnit: has('credit_base_unit') ? v.credit_base_unit : undefined,
    // Only pass cuts/values through when the FULL set is present. A partial set (mid-migration, or a
    // half-finished edit) would otherwise produce a band table with a missing boundary, which is
    // worse than falling back to the documented defaults.
    cuts: [1, 2, 3, 4].every(i => has(`credit_cut_${i}`)) ? [1, 2, 3, 4].map(i => v[`credit_cut_${i}`]) : undefined,
    values: [1, 2, 3, 4, 5].every(i => has(`credit_value_${i}`)) ? [1, 2, 3, 4, 5].map(i => v[`credit_value_${i}`]) : undefined,
  };
}

module.exports = {
  chatStreamingEnabled, chatEvidenceMarkerEnabled, chatRouterEnabled,
  calibrationRevealLocked, getSetting, getTextSetting, getTextSettingStrict, iccGates, transcriptCap, minAuditorsPerPle, t1RemediationEnabled, privacyReviewRequired, identityVerificationRequired, reflectionRequired, evaluatorWeightsSha256, creditSettings, pilotTestMode, clinicalArtifactsEnabled, peerCalibrationEnabled, holdResultUntilAudited };
