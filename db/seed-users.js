// Idempotent seed of the 4 CLICS role accounts (incl. the Superadmin bootstrap).
// Run from the repo root with the PROD Supabase service-role key, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node db/seed-users.js
// Re-runnable: existing users get their password reset; the professionals row is upserted on id.
// Passwords here are throwaway DEMO credentials — rotate before the real pilot.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Passwords come from env so no real credential is hardcoded in the repo. The values below are
// throwaway DEMO fallbacks for local/dev convenience only — set SEED_*_PW in any shared or real
// environment (and prefer the participant provisioning script for real accounts).
// Non-superadmin demo accounts are placed in the Medical Council (code TMC); the
// prof_council_required check rejects any non-superadmin without a council. council_id
// is resolved at runtime (see resolveMedicalCouncil) and merged in before upsert.
const MEDICAL_COUNCIL_CODE = 'TMC';
const USERS = [
  { email: 'superadmin@clics.th', password: process.env.SEED_SUPERADMIN_PW || 'ClicsSuper#2026r2', role: 'superadmin', status: 'active', full_name_th: 'ผู้ดูแลระบบสูงสุด', full_name_en: 'Super Admin' },
  { email: 'admin@clics.th',      password: process.env.SEED_ADMIN_PW      || 'ClicsAdmin#2026r2', role: 'admin',      status: 'active', council: MEDICAL_COUNCIL_CODE, full_name_th: 'ผู้จัดการโครงการ',  full_name_en: 'Pilot Admin' },
  { email: 'doctor1@clics.th',    password: process.env.SEED_DOCTOR_PW     || 'ClicsDoc#2026r2',   role: 'physician',  status: 'active', council: MEDICAL_COUNCIL_CODE, pseudonym: 'P-001', full_name_th: 'นพ. อาสา ทดสอบ',     full_name_en: 'Dr Asa Test', specialty: 'Internal Medicine', license_number: 'TH-DEMO-001' },
  // Auditor demo account is manual_verified: the enforce_auditor_license trigger forbids an
  // ACTIVE auditor whose license is still 'unverified' (db/migration-license-invites.sql).
  { email: 'auditor1@clics.th',   password: process.env.SEED_AUDITOR_PW    || 'ClicsAudit#2026r2', role: 'auditor',    status: 'active', council: MEDICAL_COUNCIL_CODE, license_status: 'manual_verified', full_name_th: 'ผู้ตรวจประเมิน',     full_name_en: 'Expert Auditor' },
];

// Default role slot-pool capacities (superadmin locked at 1).
const SLOTS = [
  { role: 'superadmin', capacity: 1 },
  { role: 'admin',      capacity: 5 },
  { role: 'physician',  capacity: 100 },
  { role: 'auditor',    capacity: 20 },
];

// The Supabase admin API has no get-by-email, so paginate listUsers and match.
async function findByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
}

// Resolve a council code -> id (the prof_council_required check needs council_id on non-superadmins).
async function resolveCouncilId(code) {
  const { data, error } = await supabase.from('councils').select('id').eq('code', code).single();
  if (error || !data) throw new Error(`council "${code}" not found — run db/migration-councils.sql first`);
  return data.id;
}

async function seedOne(u) {
  const { email, password, council, ...profile } = u;
  if (council) profile.council_id = await resolveCouncilId(council);
  let authUser = await findByEmail(email);
  let action;
  if (authUser) {
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, { password, email_confirm: true });
    if (error) throw error;
    action = 'updated';
  } else {
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    authUser = data.user;
    action = 'created';
  }
  // Pseudonyms are globally unique. On re-runs keep the row's existing pseudonym; on first
  // insert fall back to the next free P-NNN when the preferred one is already owned by a
  // real participant (e.g. P-001 went to a Google signup before the demo seed ran).
  if (profile.pseudonym) {
    const { data: own } = await supabase.from('professionals')
      .select('pseudonym').eq('id', authUser.id).maybeSingle();
    if (own?.pseudonym) {
      profile.pseudonym = own.pseudonym;
    } else {
      const { data: taken } = await supabase.from('professionals')
        .select('id').eq('pseudonym', profile.pseudonym).maybeSingle();
      if (taken) {
        const { data: top } = await supabase.from('professionals').select('pseudonym')
          .like('pseudonym', 'P-%').order('pseudonym', { ascending: false }).limit(1);
        const next = parseInt((top?.[0]?.pseudonym || 'P-000').slice(2), 10) + 1;
        profile.pseudonym = `P-${String(next).padStart(3, '0')}`;
      }
    }
  }
  const { error: profErr } = await supabase
    .from('professionals')
    .upsert({ id: authUser.id, ...profile }, { onConflict: 'id' });
  if (profErr) throw profErr;
  console.log(`  ${action.padEnd(7)} ${email.padEnd(22)} (${profile.role})`);
}

async function seedSlots() {
  const { error } = await supabase.from('role_slots').upsert(SLOTS, { onConflict: 'role' });
  if (error) throw error;
  console.log(`  slots   ${SLOTS.map(s => `${s.role}:${s.capacity}`).join('  ')}`);
}

(async () => {
  console.log('Seeding 4 role accounts...');
  let failures = 0;
  for (const u of USERS) {
    try { await seedOne(u); }
    catch (e) { failures++; console.error(`  FAILED  ${u.email}: ${e.message}`); }
  }
  console.log('Seeding role slot pools...');
  try { await seedSlots(); }
  catch (e) { failures++; console.error(`  FAILED  role_slots: ${e.message}`); }
  console.log(failures ? `Done with ${failures} failure(s).` : 'Done. All accounts + slot pools ready.');
  process.exit(failures ? 1 : 0);
})();
