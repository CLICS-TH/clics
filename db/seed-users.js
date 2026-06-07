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
const USERS = [
  { email: 'superadmin@clics.th', password: process.env.SEED_SUPERADMIN_PW || 'ClicsSuper#2026r2', role: 'superadmin', status: 'active', full_name_th: 'ผู้ดูแลระบบสูงสุด', full_name_en: 'Super Admin' },
  { email: 'admin@clics.th',      password: process.env.SEED_ADMIN_PW      || 'ClicsAdmin#2026r2', role: 'admin',      status: 'active', full_name_th: 'ผู้จัดการโครงการ',  full_name_en: 'Pilot Admin' },
  { email: 'doctor1@clics.th',    password: process.env.SEED_DOCTOR_PW     || 'ClicsDoc#2026r2',   role: 'physician',  status: 'active', pseudonym: 'P-001', full_name_th: 'นพ. อาสา ทดสอบ',     full_name_en: 'Dr Asa Test', specialty: 'Internal Medicine', license_number: 'TH-DEMO-001' },
  { email: 'auditor1@clics.th',   password: process.env.SEED_AUDITOR_PW    || 'ClicsAudit#2026r2', role: 'auditor',    status: 'active', full_name_th: 'ผู้ตรวจประเมิน',     full_name_en: 'Expert Auditor' },
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

async function seedOne(u) {
  const { email, password, ...profile } = u;
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
