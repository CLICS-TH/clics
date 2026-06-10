// Surgically change ONLY the superadmin account's password (nothing else touched).
// Use this to rotate the demo password before the real pilot — the new password is read
// from env so it is never written into the repo or printed anywhere persistent.
//
// Run from the backend dir so it picks up the prod Supabase service-role key in backend/.env:
//   cd backend && SUPERADMIN_NEW_PW='<your new strong password>' node ../db/set-superadmin-password.js
//
// (Override the target with SUPERADMIN_EMAIL=... ; defaults to superadmin@clics.th.)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@clics.th';
const NEW_PW = process.env.SUPERADMIN_NEW_PW;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✗ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run from the backend dir so backend/.env loads).');
  process.exit(1);
}
// Match the account password policy (>=10, letter + digit); insist on >=12 for the superadmin.
if (!NEW_PW || NEW_PW.length < 12 || !/[A-Za-z]/.test(NEW_PW) || !/[0-9]/.test(NEW_PW)) {
  console.error('✗ Set SUPERADMIN_NEW_PW to a strong password (>=12 chars, including a letter and a digit).');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

// The admin API has no get-by-email, so paginate listUsers and match (mirrors db/seed-users.js).
async function findByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
}

(async () => {
  const user = await findByEmail(EMAIL);
  if (!user) { console.error(`✗ No auth user found for ${EMAIL}.`); process.exit(1); }

  // Safety: confirm this account really is the superadmin before changing it.
  const { data: prof } = await supabase.from('professionals').select('role').eq('id', user.id).single();
  if (prof?.role !== 'superadmin') {
    console.error(`✗ ${EMAIL} is role "${prof?.role ?? 'unknown'}", not superadmin — refusing to change it.`);
    process.exit(1);
  }

  const { error } = await supabase.auth.admin.updateUserById(user.id, { password: NEW_PW, email_confirm: true });
  if (error) { console.error(`✗ Failed to update password: ${error.message}`); process.exit(1); }
  console.log(`✓ Superadmin password updated for ${EMAIL}. (Old demo password no longer works.)`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
