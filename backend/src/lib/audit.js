// Append-only audit trail (CLICS_Proposal §9.4). One row per access/scoring/provisioning action,
// readable only by oversight roles (superadmin / ethics). FAIL-SOFT by design: a logging failure
// (or a pre-migration environment without the table) must NEVER break the user action it records,
// so every call is wrapped and swallowed. Call WITHOUT await (fire-and-forget) on hot paths.
const { supabase } = require('./supabase');

const auditRow = ({ actorId = null, actorRole = null, action, targetType = null, targetId = null, councilId = null, metadata = null }) => ({
  actor_id: actorId, actor_role: actorRole, action,
  target_type: targetType, target_id: targetId, council_id: councilId, metadata,
});

async function logEvent(event) {
  try {
    const { error } = await supabase.from('audit_log').insert(auditRow(event));
    if (error) console.error('[audit] logEvent failed:', error.message);
  } catch (e) {
    console.error('[audit] logEvent threw:', e.message);
  }
}

// The opposite contract, for the few actions whose audit entry IS the point: locking and unlocking the
// PIS-7 evaluator (routes/superadmin.js). An unaudited lock or unlock is a change to the study's
// measuring instrument with nothing on the record, so the caller awaits this and undoes the action
// when it fails. Returns { ok: true } or { error } — never throws, never swallows. logEvent above is
// unchanged for its other callers.
async function logEventStrict(event) {
  try {
    const { error } = await supabase.from('audit_log').insert(auditRow(event));
    if (error) {
      console.error('[audit] logEventStrict failed:', error.message);
      return { error };
    }
    return { ok: true };
  } catch (e) {
    console.error('[audit] logEventStrict threw:', e?.message || String(e));
    return { error: { message: e?.message || String(e) } };
  }
}

module.exports = { logEvent, logEventStrict };
