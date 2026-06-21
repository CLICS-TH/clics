// Shared read access to the app_settings bag (superadmin-managed). Kept tiny + fail-soft so a
// missing key / pre-migration env falls back to the default instead of throwing.
const { supabase } = require('./supabase');

async function getSetting(key, def = null) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  const v = Number(data?.value);
  return Number.isFinite(v) ? v : def;
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

module.exports = { getSetting, pilotTestMode, clinicalArtifactsEnabled };
