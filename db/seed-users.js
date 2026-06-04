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

const USERS = [
  { email: 'superadmin@clics.th', password: 'ClicsSuper#2026', role: 'superadmin', full_name_th: 'ผู้ดูแลระบบสูงสุด', full_name_en: 'Super Admin' },
  { email: 'admin@clics.th',      password: 'ClicsAdmin#2026', role: 'admin',      full_name_th: 'ผู้จัดการโครงการ',  full_name_en: 'Pilot Admin' },
  { email: 'doctor1@clics.th',    password: 'ClicsDoc#2026',   role: 'physician',  full_name_th: 'นพ. อาสา ทดสอบ',     full_name_en: 'Dr Asa Test', specialty: 'Internal Medicine', license_number: 'TH-DEMO-001' },
  { email: 'auditor1@clics.th',   password: 'ClicsAudit#2026', role: 'auditor',    full_name_th: 'ผู้ตรวจประเมิน',     full_name_en: 'Expert Auditor' },
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

(async () => {
  console.log('Seeding 4 role accounts...');
  let failures = 0;
  for (const u of USERS) {
    try { await seedOne(u); }
    catch (e) { failures++; console.error(`  FAILED  ${u.email}: ${e.message}`); }
  }
  console.log(failures ? `Done with ${failures} failure(s).` : 'Done. All 4 accounts ready.');
  process.exit(failures ? 1 : 0);
})();
