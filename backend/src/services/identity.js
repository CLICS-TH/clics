// Professional identity verification (CREC082 ICF §4, Infrastructure Statement "Professional
// identity", Declaration "Identity verification").
//
// The protocol: "ก่อนเริ่ม PLE ระบบยืนยันตัวตนด้วย ThaID หรือการตรวจสอบเลขประจำตัวประชาชนร่วมกับ
// เลขที่ใบอนุญาตประกอบวิชาชีพเวชกรรม" — before a physician's first PLE, identity is verified either
// by ThaID or by checking their national ID together with their medical licence number. It also
// requires the identity layer to be SEPARATE from the research dataset.
//
// What was here: Google / email+password sign-in only. The TMC licence gate was switched off in
// June 2026 (db/migration-drop-license-gate.sql) and `professionals.license_number` has sat unused
// since. So the system currently knows an email address and nothing else about who a physician is.
//
// THREE DESIGN POINTS, each of which is the reason for a piece of the shape below.
//
// 1. SEPARATE TABLE, NOT COLUMNS ON professionals. The protocol asks for it explicitly, and it is
//    also what makes the research export safe by construction: `professionals` is embedded all over
//    the admin and export paths, so a national ID living there would be one careless `select('*')`
//    away from a spreadsheet. Nothing joins identity_verifications except this module.
//
// 2. THE NATIONAL ID IS NEVER STORED IN THE CLEAR, and never returned by any endpoint. It is
//    encrypted (reversible — the team may have to re-check it) plus a keyed blind index for
//    uniqueness. See lib/crypto.blindIndex for why a plain hash would not do.
//
// 3. AUTOMATED CHECK, HUMAN DECISION. The licence verifier can confirm that a licence exists and
//    the name on it matches. It cannot confirm that the person typing it is that person, and
//    neither can a national-ID checksum. Treating a green licence lookup as identity would be
//    claiming something the evidence does not support, so the lookup is EVIDENCE attached to a
//    submission and an administrator makes the call. ThaID, when it lands, is the route that does
//    prove possession — it slots in as another `method` behind the same table and the same gate.
const { supabase } = require('../lib/supabase');
const { encryptJson, blindIndex } = require('../lib/crypto');
const { getVerifier } = require('./license-verifier');
const nationalId = require('../lib/national-id');

const METHODS = ['national_id_license', 'thaid'];
const STATUSES = ['pending', 'verified', 'rejected'];

// Only 'verified' clears a physician to run a PLE. 'pending' means submitted and waiting; a
// submission that has not been looked at is not a verification.
const CLEARED = ['verified'];

// Has this physician been verified? Reads the identity table directly rather than a denormalised
// flag on professionals, so there is exactly one source of truth and no cache to go stale.
async function isVerified(physicianId) {
  const { data, error } = await supabase.from('identity_verifications')
    .select('id').eq('professional_id', physicianId).in('status', CLEARED).limit(1);
  // Fail CLOSED on a read error. An identity gate that opens when the database hiccups is not a
  // gate. The caller surfaces this as "try again", not as "you are verified".
  if (error) throw new Error(`identity check failed: ${error.message}`);
  return (data ?? []).length > 0;
}

// The physician's own view of where they stand. Deliberately returns no identifier back — not even
// the last four digits — because the caller is a browser and the value has no use there.
async function statusFor(physicianId) {
  const { data } = await supabase.from('identity_verifications')
    .select('id, method, status, submitted_at, decided_at, reject_reason, license_number, license_check_status')
    .eq('professional_id', physicianId).order('submitted_at', { ascending: false }).limit(1);
  const row = (data ?? [])[0];
  if (!row) return { status: 'none' };
  return {
    status: row.status, method: row.method,
    submitted_at: row.submitted_at, decided_at: row.decided_at,
    reject_reason: row.reject_reason ?? null,
    license_number: row.license_number ?? null,
    license_check_status: row.license_check_status ?? null,
  };
}

// Submit a national-ID + licence pair for verification.
//
// Returns { ok: false, code } for anything the physician can fix themselves, so the UI can say what
// is wrong rather than showing a generic failure.
async function submitNationalIdLicense({ physicianId, national_id, license_number, full_name_th, full_name_en }) {
  const nid = nationalId.normalise(national_id);
  // Checked before anything is written or looked up. A mistyped digit is caught with certainty by
  // the mod-11 check, and catching it here costs nobody any administrator time.
  if (!nationalId.isValid(nid)) return { ok: false, code: 'invalid_national_id' };
  const lic = String(license_number ?? '').trim();
  if (!lic) return { ok: false, code: 'license_required' };

  const nidIndex = blindIndex(nid, 'national_id');

  // One national ID, one physician. Checked against the blind index, so this comparison never needs
  // the plaintext of anybody else's number.
  const { data: clash } = await supabase.from('identity_verifications')
    .select('professional_id').eq('national_id_index', nidIndex)
    .neq('professional_id', physicianId).in('status', ['pending', 'verified']).limit(1);
  if ((clash ?? []).length) return { ok: false, code: 'national_id_already_used' };

  // Best-effort evidence. The verifier degrades to 'unavailable' when the scraper is down, and an
  // administrator can still decide on a submission with no lookup attached — so a verifier outage
  // slows verification down, it does not stop it.
  let check = { status: 'unavailable', source: 'none', evidence: null };
  try {
    check = await getVerifier().verify({ license_number: lic, full_name_th, full_name_en });
  } catch (e) {
    console.error('[identity] licence lookup failed, submitting without evidence:', e.message);
  }

  // Supersede any earlier undecided submission from this physician, so a corrected resubmission
  // does not leave two pending rows for an administrator to reconcile.
  await supabase.from('identity_verifications')
    .update({ status: 'rejected', reject_reason: 'superseded by a later submission', decided_at: new Date().toISOString() })
    .eq('professional_id', physicianId).eq('status', 'pending');

  const { data, error } = await supabase.from('identity_verifications').insert({
    professional_id: physicianId,
    method: 'national_id_license',
    status: 'pending',
    national_id_encrypted: encryptJson(nid),
    national_id_index: nidIndex,
    national_id_last4: nationalId.last4(nid),
    license_number: lic,
    license_check_status: check.status,
    license_check_source: check.source,
    license_evidence_encrypted: check.evidence ? encryptJson(check.evidence) : null,
    submitted_at: new Date().toISOString(),
  }).select('id, status').single();
  if (error) return { ok: false, code: 'submit_failed', message: error.message };
  return { ok: true, id: data.id, status: data.status, license_check_status: check.status };
}

// An administrator's decision. `verified` is an assertion that a human matched this person to this
// licence, so it carries who and when.
async function decide({ verificationId, decidedBy, decision, reason }) {
  if (!STATUSES.includes(decision) || decision === 'pending') return { ok: false, code: 'bad_decision' };
  const { data, error } = await supabase.from('identity_verifications').update({
    status: decision,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    reject_reason: decision === 'rejected' ? (reason ?? null) : null,
  }).eq('id', verificationId).select('id, professional_id, status').single();
  if (error) return { ok: false, code: 'decide_failed', message: error.message };
  return { ok: true, ...data };
}

module.exports = { METHODS, STATUSES, CLEARED, isVerified, statusFor, submitNationalIdLicense, decide };
