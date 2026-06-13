// Shared "provision a professional" routine — the single insert path used by physician
// self-signup (OTP/Google), invite-accept, and superadmin create. Reuses the slot pool,
// pseudonym series, and the on-prem identity vault so every path enforces the same rules.
//
// Returns { ok: true, professional } or { ok: false, code, error } (HTTP-mappable). It does
// NOT create or delete the Supabase auth user — the caller owns that lifecycle/rollback.
const { supabase } = require('./supabase');
const { assertSlotAvailable, nextPseudonym } = require('./accounts');
const { encryptJson } = require('./crypto');
const { normalizeCanAudit } = require('./dual-role');

async function provisionProfessional({
  authUserId, role, councilId,
  full_name_th, full_name_en, specialty = null, status = 'active',
  can_audit = false, // "Special" dual role: physician + auditor rights (Special invites)
  // License No. + TMC verification were retired (2026-06-09): onboarding is Google + invite.
  // These columns are kept DORMANT — written ONLY if a caller still passes them (reversible).
  license_number = null, license_status = null,
  identity = null, // { provider, provider_subject, payload } -> on-prem encrypted vault row
}) {
  const slot = await assertSlotAvailable(role, councilId);
  if (!slot.ok) return { ok: false, code: 'slot_full', error: slot.error };

  const insert = {
    id: authUserId,
    role,
    council_id: councilId,
    full_name_th: full_name_th || full_name_en || 'Unknown',
    full_name_en: full_name_en || full_name_th || 'Unknown',
    specialty,
    status,
  };
  // "Special" (can_audit) is valid ONLY on a physician — normalize through the single source of
  // truth so OAuth signup / invite-accept can never set it on an admin/auditor (the DB CHECK
  // can_audit_physician_only is the backstop). Only write when true (pre-migration tolerant).
  if (normalizeCanAudit(role, can_audit)) insert.can_audit = true;
  if (license_number != null) insert.license_number = license_number;
  if (license_status != null) {
    insert.license_status = license_status;
    if (license_status === 'verified' || license_status === 'manual_verified') {
      insert.license_verified_at = new Date().toISOString();
    }
  }
  if (role === 'physician') insert.pseudonym = await nextPseudonym();

  const { data, error } = await supabase.from('professionals').insert(insert).select('*').single();
  if (error) return { ok: false, code: 'insert_failed', error: error.message };

  if (identity) {
    const { error: vaultErr } = await supabase.from('oauth_identities').insert({
      auth_user_id: authUserId,
      professional_id: authUserId, // professionals.id === auth.users.id
      provider: identity.provider,
      provider_subject: identity.provider_subject,
      identity_encrypted: encryptJson(identity.payload),
    });
    if (vaultErr) {
      // Roll back the professional so the caller can cleanly roll back the auth user too.
      await supabase.from('professionals').delete().eq('id', authUserId);
      return { ok: false, code: 'vault_failed', error: vaultErr.message };
    }
  }

  return { ok: true, professional: data };
}

module.exports = { provisionProfessional };
