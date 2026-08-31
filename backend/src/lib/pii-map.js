// Reversible on-prem PII map (Tier-1 audit). RIMPL returns a token->raw map it built on-prem during
// de-identification; the backend (sole holder of IDENTITY_ENC_KEY) encrypts it and stores ONE row per
// PLE in ple_pii_map (RLS deny-all). Fail-soft: the map is not critical to the PLE lifecycle, so a
// write failure is logged and swallowed — finalization must never fail on it.
const { supabase } = require('./supabase');
const { encryptJson } = require('./crypto');

async function persistPiiMap(pleId, map) {
  if (!Array.isArray(map) || map.length === 0) return; // nothing to store (no PII in the transcript)
  try {
    const { error } = await supabase.from('ple_pii_map').upsert({
      ple_id: pleId,
      map_encrypted: encryptJson(map), // AES-256-GCM — never plaintext at rest
      entry_count: map.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'ple_id' });
    if (error) console.error(`[pii-map] persist failed for PLE ${pleId}:`, error.message);
  } catch (e) {
    console.error(`[pii-map] persist threw for PLE ${pleId}:`, e.message);
  }
}

module.exports = { persistPiiMap };
