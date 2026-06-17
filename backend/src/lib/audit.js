// Append-only audit trail (CLICS_Proposal §9.4). One row per access/scoring/provisioning action,
// readable only by oversight roles (superadmin / ethics). FAIL-SOFT by design: a logging failure
// (or a pre-migration environment without the table) must NEVER break the user action it records,
// so every call is wrapped and swallowed. Call WITHOUT await (fire-and-forget) on hot paths.
const { supabase } = require('./supabase');

async function logEvent({ actorId = null, actorRole = null, action, targetType = null, targetId = null, councilId = null, metadata = null }) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      actor_id: actorId, actor_role: actorRole, action,
      target_type: targetType, target_id: targetId, council_id: councilId, metadata,
    });
    if (error) console.error('[audit] logEvent failed:', error.message);
  } catch (e) {
    console.error('[audit] logEvent threw:', e.message);
  }
}

module.exports = { logEvent };
