// db/reset-demo.js — FULL CLEAN SLATE reset of the CLICS app.
//
// Wipes ALL activity (PLEs + messages + AI evals + audit scores + LPDP + access
// requests + OAuth identities) and ALL accounts EXCEPT the superadmin bootstrap,
// then resets the role slot pools. Use before a fresh demo/soak run.
//
//   cd backend && NODE_PATH="$PWD/node_modules" node ../db/reset-demo.js
//
// Reads backend/.env for the prod Supabase service-role key. DESTRUCTIVE — there is
// no undo. Re-create demo accounts afterwards with db/seed-users.js if desired.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const KEEP_SUPERADMIN = 'superadmin@clics.th';
const SUPERADMIN_PW = 'ClicsSuper#2026r2';
const NIL = '00000000-0000-0000-0000-000000000000'; // sentinel so "delete all" has a filter
const SLOTS = [
  { role: 'superadmin', capacity: 1 }, { role: 'admin', capacity: 5 },
  { role: 'physician', capacity: 100 }, { role: 'auditor', capacity: 20 },
];

async function count(table) {
  const { count } = await supabase.from(table).select('id', { count: 'exact', head: true });
  return count ?? 0;
}
async function snapshot(label) {
  const tables = ['professionals', 'ples', 'messages', 'ai_evaluations', 'audit_scores', 'lpdp_snapshots', 'access_requests', 'oauth_identities'];
  const out = {};
  for (const t of tables) out[t] = await count(t);
  console.log(`\n${label}:`);
  for (const [t, n] of Object.entries(out)) console.log(`  ${t.padEnd(18)} ${n}`);
  return out;
}
async function wipe(table) {
  const { error } = await supabase.from(table).delete().neq('id', NIL);
  if (error) throw new Error(`wipe ${table}: ${error.message}`);
}
async function listAllUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

(async () => {
  console.log('CLICS FULL RESET — wiping all activity + non-superadmin accounts.');
  await snapshot('BEFORE');

  // Order matters: lpdp + ples-cascade first (FKs to professionals have no cascade),
  // then standalone tables, then auth users (deleting an auth user cascades its professional).
  await wipe('lpdp_snapshots');
  await wipe('ples');             // cascades messages, ai_evaluations, audit_scores
  await wipe('access_requests');
  await wipe('oauth_identities');

  const all = await listAllUsers();
  const keep = all.find(u => u.email?.toLowerCase() === KEEP_SUPERADMIN.toLowerCase());
  let deleted = 0;
  for (const u of all) {
    if (keep && u.id === keep.id) continue;
    await supabase.auth.admin.deleteUser(u.id); // cascades the professionals row
    deleted++;
  }
  console.log(`\nDeleted ${deleted} non-superadmin auth users.`);

  // Ensure the superadmin bootstrap exists, active, with a known password.
  let saId = keep?.id;
  if (saId) {
    await supabase.auth.admin.updateUserById(saId, { password: SUPERADMIN_PW, email_confirm: true });
  } else {
    const { data, error } = await supabase.auth.admin.createUser({ email: KEEP_SUPERADMIN, password: SUPERADMIN_PW, email_confirm: true });
    if (error) throw error;
    saId = data.user.id;
  }
  await supabase.from('professionals').upsert({
    id: saId, role: 'superadmin', status: 'active',
    full_name_th: 'ผู้ดูแลระบบสูงสุด', full_name_en: 'Super Admin',
  }, { onConflict: 'id' });

  await supabase.from('role_slots').upsert(SLOTS, { onConflict: 'role' });
  console.log('Superadmin reset; slot pools restored to defaults.');

  await snapshot('AFTER');
  console.log('\nClean slate ready. Only the superadmin remains.');
  process.exit(0);
})().catch(e => { console.error('RESET FAILED:', e.message); process.exit(1); });
