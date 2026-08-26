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
  const { data, error } = await supabase.from('app_settings').select('value_text').eq('key', key).maybeSingle();
  // Pre-migration (no value_text column) this errors rather than returning null. Fall back to the
  // default instead of throwing: the same fail-soft contract getSetting() has always had.
  if (error) return def;
  const v = typeof data?.value_text === 'string' ? data.value_text.trim() : '';
  return v || def;
}

// Pilot Test Mode (CLICS pilot): when ON, CLE creation produces TEST sessions, bypasses the 3-CLE
// study cap, and honours a physician-chosen Socratic mode — so the team can exercise the experiment.
async function pilotTestMode() {
  return (await getSetting('pilot_test_mode', 0)) === 1;
}

// Clinical Artifacts (superadmin toggle): when ON, the chat call tells RIMPL it may emit
// `:::artifact{...}` side-panel blocks. Default OFF — a research-stimulus change, enabled deliberately.
async function clinicalArtifactsEnabled() {
  return (await getSetting('clinical_artifacts', 0)) === 1;
}

// Peer Calibration (superadmin toggle): when ON, a CLE may be assigned to several auditors and the
// auditor reveal pane shows a you-vs-auditor-average PIS-7 radar. Default OFF (single-auditor blind audit).
async function peerCalibrationEnabled() {
  return (await getSetting('peer_calibration', 0)) === 1;
}

// Hold Result Until Audited (superadmin toggle, for a blinded test round): when ON, a physician's
// PIS-7 score is withheld (shown as "under expert review") until an expert auditor has submitted a
// score for that CLE — so physicians can't see/compare scores before review. Default OFF.
async function holdResultUntilAudited() {
  return (await getSetting('hold_result_until_audited', 0)) === 1;
}

// Minimum auditors per CLE (superadmin dial, default 1). The manuscript describes >= 3 blinded
// auditors per CLE; staffing does not support that yet (3 auditors cover 3 of 19 physician
// specialties). So this WARNS, it does not BLOCK: a CLE below target is badged in the admin queue
// and reported in the ICC cohort, but its score still releases. Blocking would strand credit for
// specialties that have no eligible auditor at all — a worse failure than a thin rater count.
async function minAuditorsPerCle() {
  const n = await getSetting('min_auditors_per_cle', 1);
  return Math.max(1, Math.min(10, Math.round(n)));
}

// The credit-conversion policy, as data. Ships with credit_conversion_enabled = 0, so the physician
// UI shows the band as a PREVIEW and the existing "ยังไม่นับเป็นหน่วยกิต CME" wording is unchanged.
// One batched read: this sits on the CLE-result path, and eleven sequential awaits would not.
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

module.exports = { getSetting, getTextSetting, minAuditorsPerCle, creditSettings, pilotTestMode, clinicalArtifactsEnabled, peerCalibrationEnabled, holdResultUntilAudited };
